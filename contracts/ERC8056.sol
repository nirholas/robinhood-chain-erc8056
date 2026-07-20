// SPDX-License-Identifier: LicenseRef-Proprietary
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IERC8056, IERC8056Scheduled} from "./IERC8056.sol";

/**
 * @title ERC8056
 * @notice Reference implementation of ERC-8056 over a standard ERC-20.
 *
 * @dev What this contract does, and what it deliberately does not do.
 *
 *      It adds one piece of global state to an otherwise untouched ERC-20: a
 *      1e18-scaled `uiMultiplier` recording how many shares one token represents.
 *      Corporate actions move that number. They never move a balance, never mint,
 *      never burn, and never emit `Transfer`. Every ERC-20 invariant an integrator
 *      relies on (`balanceOf` is stable absent a transfer, the sum of balances is
 *      `totalSupply`, `transfer(x)` moves exactly `x`) survives a split untouched.
 *
 *      Rebasing does the opposite: it keeps the share count stable and lets the
 *      balance move under everyone's feet. That is why rebasing tokens break AMM
 *      pools, lending collateral accounting, and every cached balance in the system.
 *      ERC-8056 pushes the adjustment into a value integrators explicitly opt into
 *      reading, so integrations that never heard of the standard keep working on
 *      unchanged numbers instead of silently computing wrong ones.
 *
 *      Fixed-point discipline:
 *
 *      - `WAD` (1e18) is the multiplier scale. `uiMultiplier() == WAD` means 1:1.
 *      - Every conversion goes through {Math-mulDiv}, which computes
 *        `a * b / denominator` with a full 512-bit intermediate product. A plain
 *        `(balance * multiplier) / WAD` would revert on holders whose balance
 *        exceeds `type(uint256).max / multiplier`, even though the final result
 *        fits comfortably. mulDiv only reverts when the RESULT itself overflows.
 *      - Division truncates toward zero, always. See {balanceOfUI} for why rounding
 *        up would be a solvency bug rather than a cosmetic choice.
 *
 *      Hot path cost: {balanceOfUI} is one extra SLOAD (packed multiplier slot) plus
 *      one mulDiv over the inherited {ERC20-balanceOf}. `transfer`, `approve`, and
 *      `transferFrom` are completely untouched and cost exactly what they cost on a
 *      vanilla ERC-20.
 *
 *      Scheduling: corporate actions are announced before they are effective, so
 *      this base stores a pending multiplier alongside a `effectiveAt` timestamp and
 *      switches over at that timestamp with no transaction required. Reads are
 *      therefore time-dependent by design; {syncMultiplier} folds a matured pending
 *      action into storage for anyone who wants the cheaper read afterward.
 *
 *      Authorization is deliberately left abstract. Corporate actions are the single
 *      most sensitive operation on a tokenized security, and the right guard is
 *      issuer-specific (a multisig, a timelock, a transfer-agent role). Implement
 *      {_authorizeCorporateAction} in the concrete token. See {ERC8056StockToken}
 *      for a worked example.
 */
abstract contract ERC8056 is ERC20, IERC8056, IERC8056Scheduled {
    /// @notice The fixed-point scale for `uiMultiplier`. `WAD` represents 1.0.
    uint256 public constant WAD = 1e18;

    /**
     * @notice Upper bound on any multiplier this contract will accept.
     * @dev 1e18x the original share count. No real corporate action approaches this;
     *      the bound exists so a fat-fingered admin cannot push the multiplier into a
     *      range where {balanceOfUI} starts reverting on overflow for ordinary holders,
     *      which would brick every integration reading share equivalents. Rejecting
     *      the bad input at write time is recoverable. Discovering it at read time is not.
     */
    uint256 public constant MAX_UI_MULTIPLIER = 1e36;

    /// @dev The multiplier in force until `_pendingEffectiveAt` arrives.
    uint256 private _currentMultiplier;

    /// @dev The multiplier scheduled to take over, meaningful only when `_pendingEffectiveAt != 0`.
    uint256 private _pendingMultiplier;

    /// @dev Effective timestamp of the pending action, or `0` when nothing is scheduled.
    uint256 private _pendingEffectiveAt;

    /// @notice Thrown when a multiplier of zero is supplied. Zero would zero out every share balance.
    error ERC8056ZeroMultiplier();

    /// @notice Thrown when a multiplier above {MAX_UI_MULTIPLIER} is supplied.
    /// @param multiplier The rejected value.
    error ERC8056MultiplierTooLarge(uint256 multiplier);

    /// @notice Thrown when a corporate action is scheduled with an effective time in the past.
    /// @param effectiveAt The rejected timestamp.
    /// @param currentTime The block timestamp at the point of rejection.
    error ERC8056EffectiveInPast(uint256 effectiveAt, uint256 currentTime);

    /// @notice Thrown when a split ratio has a zero numerator or denominator.
    error ERC8056InvalidRatio(uint256 numerator, uint256 denominator);

    /**
     * @param name_   ERC-20 name.
     * @param symbol_ ERC-20 symbol.
     * @dev Starts at `WAD`: one token is one share until the first corporate action.
     *      Every canonical Robinhood Stock Token is in exactly this state today.
     */
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        _currentMultiplier = WAD;
        emit UIMultiplierUpdated(0, WAD, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // IERC8056
    // ---------------------------------------------------------------------

    /// @inheritdoc IERC8056
    function uiMultiplier() public view virtual returns (uint256) {
        uint256 effectiveAt_ = _pendingEffectiveAt;
        if (effectiveAt_ != 0 && block.timestamp >= effectiveAt_) {
            return _pendingMultiplier;
        }
        return _currentMultiplier;
    }

    /// @inheritdoc IERC8056
    function balanceOfUI(address account) public view virtual returns (uint256) {
        return Math.mulDiv(balanceOf(account), uiMultiplier(), WAD);
    }

    /// @inheritdoc IERC8056
    function totalSupplyUI() public view virtual returns (uint256) {
        return Math.mulDiv(totalSupply(), uiMultiplier(), WAD);
    }

    // ---------------------------------------------------------------------
    // IERC8056Scheduled
    // ---------------------------------------------------------------------

    /// @inheritdoc IERC8056Scheduled
    function newUIMultiplier() public view virtual returns (uint256) {
        return _pendingEffectiveAt == 0 ? _currentMultiplier : _pendingMultiplier;
    }

    /// @inheritdoc IERC8056Scheduled
    function effectiveAt() public view virtual returns (uint256) {
        return _pendingEffectiveAt;
    }

    // ---------------------------------------------------------------------
    // Corporate actions
    // ---------------------------------------------------------------------

    /**
     * @notice Fold a matured pending corporate action into storage.
     * @dev Permissionless and idempotent. It cannot change any value any caller
     *      observes: {uiMultiplier} already returns the pending value once its
     *      effective time has passed. All this does is retire the branch, making
     *      every later read cheaper. Safe to leave uncalled forever.
     */
    function syncMultiplier() public virtual {
        uint256 effectiveAt_ = _pendingEffectiveAt;
        if (effectiveAt_ != 0 && block.timestamp >= effectiveAt_) {
            _currentMultiplier = _pendingMultiplier;
            _pendingMultiplier = 0;
            _pendingEffectiveAt = 0;
        }
    }

    /**
     * @notice Authorization hook for every corporate action. Reverts to deny.
     * @dev Implement in the concrete token. Called before any state change in
     *      {_scheduleCorporateAction}, so a reverting hook guarantees no partial write.
     */
    function _authorizeCorporateAction() internal view virtual;

    /**
     * @notice Schedule a corporate action that sets the multiplier to `newMultiplier`
     *         at `effectiveAt_`.
     * @dev The single write path for every corporate action. `_applyCorporateAction`
     *      and `_applySplit` both funnel through here.
     *
     *      Scheduling replaces any previously scheduled action that has not yet
     *      matured, which is how a corrected or cancelled announcement is handled.
     *      A pending action that HAS matured is folded into storage first, so
     *      replacing an announcement can never discard an action that already took
     *      economic effect.
     *
     * @param newMultiplier The 1e18-scaled multiplier to move to. Must be in
     *        `(0, MAX_UI_MULTIPLIER]`.
     * @param effectiveAt_ Unix timestamp at which it takes effect. Must be now or
     *        later. Pass `block.timestamp` for an immediate action.
     */
    function _scheduleCorporateAction(uint256 newMultiplier, uint256 effectiveAt_) internal virtual {
        _authorizeCorporateAction();

        if (newMultiplier == 0) revert ERC8056ZeroMultiplier();
        if (newMultiplier > MAX_UI_MULTIPLIER) revert ERC8056MultiplierTooLarge(newMultiplier);
        if (effectiveAt_ < block.timestamp) revert ERC8056EffectiveInPast(effectiveAt_, block.timestamp);

        // Never discard an action that already took effect.
        syncMultiplier();

        uint256 oldMultiplier = _currentMultiplier;

        if (effectiveAt_ == block.timestamp) {
            _currentMultiplier = newMultiplier;
            _pendingMultiplier = 0;
            _pendingEffectiveAt = 0;
        } else {
            _pendingMultiplier = newMultiplier;
            _pendingEffectiveAt = effectiveAt_;
        }

        emit UIMultiplierUpdated(oldMultiplier, newMultiplier, effectiveAt_);
    }

    /**
     * @notice Apply a corporate action immediately.
     * @param newMultiplier The 1e18-scaled multiplier to move to.
     */
    function _applyCorporateAction(uint256 newMultiplier) internal virtual {
        _scheduleCorporateAction(newMultiplier, block.timestamp);
    }

    /**
     * @notice Apply a split expressed as a ratio, relative to the current multiplier.
     * @dev A 4:1 forward split is `_applySplit(4, 1)`. A 1:10 reverse split is
     *      `_applySplit(1, 10)`. A 0.37% reinvested dividend is
     *      `_applySplit(10037, 10000)`.
     *
     *      The new multiplier is `mulDiv(current, numerator, denominator)`, truncated.
     *      Truncation means a sequence of ratio actions is NOT exactly associative:
     *      applying (1,3) then (3,1) lands one wei below where you started. That is
     *      inherent to fixed point, and it is why an issuer correcting a multiplier
     *      should call {_applyCorporateAction} with the exact target value rather
     *      than composing ratios. Documented, not hidden.
     *
     * @param numerator   Shares after, per `denominator` shares before.
     * @param denominator Shares before.
     */
    function _applySplit(uint256 numerator, uint256 denominator) internal virtual {
        if (numerator == 0 || denominator == 0) revert ERC8056InvalidRatio(numerator, denominator);
        _applyCorporateAction(Math.mulDiv(uiMultiplier(), numerator, denominator));
    }

    /**
     * @notice Schedule a ratio split for a future effective time.
     * @param numerator   Shares after, per `denominator` shares before.
     * @param denominator Shares before.
     * @param effectiveAt_ Unix timestamp at which the split takes effect.
     */
    function _scheduleSplit(uint256 numerator, uint256 denominator, uint256 effectiveAt_) internal virtual {
        if (numerator == 0 || denominator == 0) revert ERC8056InvalidRatio(numerator, denominator);
        _scheduleCorporateAction(Math.mulDiv(uiMultiplier(), numerator, denominator), effectiveAt_);
    }

    // ---------------------------------------------------------------------
    // Conversion helpers
    // ---------------------------------------------------------------------

    /**
     * @notice Convert a token amount to share-equivalent units at the current multiplier.
     * @param tokenAmount Amount in TOKEN units (what `transfer` moves).
     * @return shares The equivalent amount in SHARE units, truncated.
     */
    function tokensToShares(uint256 tokenAmount) public view virtual returns (uint256 shares) {
        return Math.mulDiv(tokenAmount, uiMultiplier(), WAD);
    }

    /**
     * @notice Convert a share-equivalent amount back to token units at the current multiplier.
     * @dev The inverse of {tokensToShares}, and lossy in the same way: converting a
     *      token amount to shares and back can land one wei low. Use this to answer
     *      "how many tokens must I transfer to move N shares", and round the result
     *      up at the call site if the exact share count must be met.
     * @param shareAmount Amount in SHARE units.
     * @return tokens The equivalent amount in TOKEN units, truncated.
     */
    function sharesToTokens(uint256 shareAmount) public view virtual returns (uint256 tokens) {
        return Math.mulDiv(shareAmount, WAD, uiMultiplier());
    }
}
