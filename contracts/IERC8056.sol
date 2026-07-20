// SPDX-License-Identifier: LicenseRef-Proprietary
pragma solidity ^0.8.24;

/**
 * @title IERC8056
 * @notice The ERC-8056 corporate-actions interface: a token-side multiplier that
 *         absorbs splits, reverse splits, and reinvested dividends WITHOUT ever
 *         rewriting holder balances.
 *
 * @dev The problem ERC-8056 solves.
 *
 *      A tokenized share has to survive corporate actions. When the issuer runs a
 *      4:1 split, one share becomes four. The naive on-chain answers are both bad:
 *
 *      1. Mint new tokens to every holder. Requires unbounded iteration over the
 *         holder set, breaks with contract holders (AMM pools, vaults, bridges),
 *         and is impossible for tokens held in pools that were never designed to
 *         receive an airdrop.
 *      2. Rebase, i.e. redefine `balanceOf` so every balance scales. This silently
 *         breaks every integration that cached a balance, every AMM invariant, and
 *         every accounting system that assumes `transfer(x)` moves exactly `x`.
 *
 *      ERC-8056 takes a third path: balances are immutable ledger units, and a
 *      single global `uiMultiplier()` records how many SHARES one TOKEN currently
 *      represents. A 4:1 split multiplies the multiplier by 4. No balance moves,
 *      no `Transfer` event fires, no AMM invariant shifts, and every integration
 *      that did not opt in keeps working on unchanged numbers.
 *
 *      The consequence is that a token has two distinct units, and mixing them up
 *      is the single most common integration bug:
 *
 *      - TOKEN units: what `balanceOf` returns, what `transfer` moves, what an AMM
 *        pool holds. Immutable across corporate actions.
 *      - SHARE-EQUIVALENT units: what the holder actually owns economically, and
 *        what a brokerage statement would print.
 *
 *      The conversion is fixed-point with an 18-decimal scale (`1e18` == 1.0):
 *
 *          shareEquivalent = balance * uiMultiplier / 1e18
 *
 *      This interface is implemented by every canonical Robinhood Stock Token on
 *      Robinhood Chain (chain ID 4663). See {IERC8056Scheduled} for the pending
 *      corporate-action surface those tokens also expose.
 */
interface IERC8056 {
    /**
     * @notice Emitted whenever the effective multiplier changes, i.e. whenever a
     *         corporate action is applied or scheduled.
     * @dev Indexers MUST treat this as the authoritative corporate-action signal.
     *      No `Transfer` event accompanies a corporate action, so an indexer that
     *      only watches `Transfer` will silently drift from reality after the
     *      first split.
     * @param oldMultiplier The multiplier in force before this update (1e18-scaled).
     * @param newMultiplier The multiplier in force from `effectiveAt` onward (1e18-scaled).
     * @param effectiveAt   Unix timestamp at which `newMultiplier` becomes the value
     *                      returned by {uiMultiplier}. Equal to `block.timestamp` for
     *                      an immediate action, or a future timestamp for a scheduled one.
     */
    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAt);

    /**
     * @notice How many shares one whole token currently represents, scaled by 1e18.
     * @dev `1e18` means 1 token == 1 share (the state every canonical Stock Token is
     *      in today). `4e18` means a 4:1 split has been applied. `1e17` means a 1:10
     *      reverse split has been applied.
     *
     *      MUST NOT return zero: a zero multiplier would make every share-equivalent
     *      balance zero and make the inverse conversion undefined.
     *
     *      MUST reflect the currently effective value. An implementation that
     *      schedules future actions (see {IERC8056Scheduled}) MUST return the pending
     *      value once `block.timestamp >= effectiveAt`, not before.
     *
     *      IMPORTANT for price consumers: an oracle quoting this token may already
     *      have the multiplier baked into its answer. Chainlink's Robinhood Stock
     *      Token feeds do exactly that: the answer is the price of one TOKEN
     *      (total return), not one underlying share. Applying `uiMultiplier` to such
     *      an answer double-counts the corporate action. See the README's
     *      "Two rules" section.
     * @return multiplier The 1e18-scaled shares-per-token ratio, always non-zero.
     */
    function uiMultiplier() external view returns (uint256 multiplier);

    /**
     * @notice `account`'s balance expressed in share-equivalent units.
     * @dev Defined as `balanceOf(account) * uiMultiplier() / 1e18`, with the division
     *      truncating toward zero. Truncation (not rounding half-up) is REQUIRED so
     *      that the sum of all share-equivalent balances can never exceed
     *      {totalSupplyUI}, which would let a holder set appear to own more shares
     *      than exist.
     *
     *      This is a display and accounting view. It is NOT a transferable balance:
     *      `transfer` always moves TOKEN units.
     * @param account The holder to query.
     * @return shares `account`'s holdings in share-equivalent units, same decimals as
     *         the underlying ERC-20.
     */
    function balanceOfUI(address account) external view returns (uint256 shares);

    /**
     * @notice Total supply expressed in share-equivalent units.
     * @dev Defined as `totalSupply() * uiMultiplier() / 1e18`, truncating. This is the
     *      total number of underlying shares the token contract represents.
     * @return shares The share-equivalent total supply.
     */
    function totalSupplyUI() external view returns (uint256 shares);
}

/**
 * @title IERC8056Scheduled
 * @notice The optional ERC-8056 extension for corporate actions announced ahead of
 *         their effective time.
 * @dev Real corporate actions are announced days in advance and take effect at a
 *      specific market open. This extension lets integrators read the pending action
 *      before it lands, so a UI can warn ("4:1 split effective Tuesday") instead of
 *      surprising the user with a 4x jump in their share count.
 *
 *      Canonical Robinhood Stock Tokens implement this alongside {IERC8056}.
 */
interface IERC8056Scheduled {
    /**
     * @notice The multiplier that will take effect at {effectiveAt}, 1e18-scaled.
     * @dev When no action is pending, implementations return the current multiplier
     *      rather than zero, so that a naive consumer reading this value alone still
     *      gets a usable number.
     * @return multiplier The pending 1e18-scaled multiplier.
     */
    function newUIMultiplier() external view returns (uint256 multiplier);

    /**
     * @notice Unix timestamp at which {newUIMultiplier} becomes effective.
     * @dev Returns `0` when no corporate action is scheduled. A non-zero value in the
     *      past means the action has already been absorbed, and {IERC8056-uiMultiplier}
     *      already reflects it.
     * @return timestamp The effective time, or `0` when nothing is scheduled.
     */
    function effectiveAt() external view returns (uint256 timestamp);
}
