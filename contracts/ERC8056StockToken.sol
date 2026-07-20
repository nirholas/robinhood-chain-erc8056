// SPDX-License-Identifier: LicenseRef-Proprietary
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {ERC8056} from "./ERC8056.sol";
import {IERC8056, IERC8056Scheduled} from "./IERC8056.sol";

/**
 * @title ERC8056StockToken
 * @notice A complete, deployable tokenized-equity contract built on {ERC8056}.
 *
 * @dev This is the worked example: it takes the abstract base and answers the three
 *      questions every real issuer has to answer.
 *
 *      1. Who may run a corporate action? A dedicated `CORPORATE_ACTION_ROLE`, held
 *         in practice by the transfer agent's multisig or a timelock. It is separated
 *         from issuance because the blast radius differs: a bad mint dilutes, a bad
 *         multiplier misprices every holder's position at once, in every integration
 *         reading the token, instantly. They should not share a key.
 *      2. Who may issue and redeem? `ISSUER_ROLE`, mirroring share creation and
 *         cancellation at the transfer agent.
 *      3. How does an integrator discover the standard? ERC-165. Canonical Robinhood
 *         Stock Tokens do not implement it (an integrator must probe `uiMultiplier()`
 *         and treat a revert as 1e18), but a token deployed today should, and the
 *         `erc8056` TypeScript package reads both paths.
 *
 *      Everything else is inherited and unmodified: transfers, allowances, and
 *      balances behave exactly like a vanilla ERC-20, including across corporate
 *      actions. That is the entire point of the standard.
 */
contract ERC8056StockToken is ERC8056, AccessControl {
    /// @notice Role authorized to schedule and apply corporate actions.
    bytes32 public constant CORPORATE_ACTION_ROLE = keccak256("CORPORATE_ACTION_ROLE");

    /// @notice Role authorized to mint and burn, mirroring share issuance and cancellation.
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    /// @dev Issuer terms URI, returned by {terms}.
    string private _terms;

    /**
     * @param name_   ERC-20 name, e.g. `"Apple Stock Token"`.
     * @param symbol_ ERC-20 symbol, e.g. `"AAPL"`.
     * @param terms_  URI of the issuer's terms document.
     * @param admin   Address granted `DEFAULT_ADMIN_ROLE`, `ISSUER_ROLE`, and
     *                `CORPORATE_ACTION_ROLE` at deployment. Split the roles onto
     *                separate keys before going live.
     */
    constructor(string memory name_, string memory symbol_, string memory terms_, address admin)
        ERC8056(name_, symbol_)
    {
        _terms = terms_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, admin);
        _grantRole(CORPORATE_ACTION_ROLE, admin);
    }

    /// @notice URI of the issuer's terms document for this token.
    function terms() external view returns (string memory) {
        return _terms;
    }

    // ---------------------------------------------------------------------
    // Corporate actions
    // ---------------------------------------------------------------------

    /**
     * @notice Apply a split immediately, as a ratio against the current multiplier.
     * @dev `applySplit(4, 1)` is a 4:1 forward split. `applySplit(1, 10)` is a 1:10
     *      reverse split. `applySplit(10037, 10000)` is a 0.37% reinvested dividend.
     *      No balance changes and no `Transfer` event fires: only
     *      {IERC8056-UIMultiplierUpdated}.
     * @param numerator   Shares after, per `denominator` shares before.
     * @param denominator Shares before.
     */
    function applySplit(uint256 numerator, uint256 denominator) external {
        _applySplit(numerator, denominator);
    }

    /**
     * @notice Announce a split ahead of its effective time.
     * @dev {IERC8056-uiMultiplier} keeps returning the old value until `effectiveAt_`,
     *      then switches with no further transaction. Integrators can read
     *      {ERC8056-newUIMultiplier} and {ERC8056-effectiveAt} to show the upcoming
     *      action before it lands.
     * @param numerator    Shares after, per `denominator` shares before.
     * @param denominator  Shares before.
     * @param effectiveAt_ Unix timestamp at which the split takes effect.
     */
    function scheduleSplit(uint256 numerator, uint256 denominator, uint256 effectiveAt_) external {
        _scheduleSplit(numerator, denominator, effectiveAt_);
    }

    /**
     * @notice Set the multiplier to an exact value immediately.
     * @dev Prefer {applySplit} for ordinary actions. Use this to correct a multiplier
     *      or to set a value that ratio composition cannot express exactly, since
     *      composed ratios truncate.
     * @param newMultiplier The 1e18-scaled target multiplier.
     */
    function setUIMultiplier(uint256 newMultiplier) external {
        _applyCorporateAction(newMultiplier);
    }

    /**
     * @notice Announce an exact multiplier ahead of its effective time.
     * @param newMultiplier The 1e18-scaled target multiplier.
     * @param effectiveAt_  Unix timestamp at which it takes effect.
     */
    function scheduleUIMultiplier(uint256 newMultiplier, uint256 effectiveAt_) external {
        _scheduleCorporateAction(newMultiplier, effectiveAt_);
    }

    /// @inheritdoc ERC8056
    function _authorizeCorporateAction() internal view override {
        _checkRole(CORPORATE_ACTION_ROLE);
    }

    // ---------------------------------------------------------------------
    // Issuance
    // ---------------------------------------------------------------------

    /**
     * @notice Mint tokens to `to`, mirroring newly issued shares.
     * @dev `amount` is in TOKEN units. To issue a specific number of SHARES under a
     *      non-1.0 multiplier, convert first with {ERC8056-sharesToTokens}.
     * @param to     Recipient.
     * @param amount Amount in TOKEN units.
     */
    function mint(address to, uint256 amount) external onlyRole(ISSUER_ROLE) {
        _mint(to, amount);
    }

    /**
     * @notice Burn tokens from `from`, mirroring cancelled shares.
     * @param from   Holder to burn from.
     * @param amount Amount in TOKEN units.
     */
    function burn(address from, uint256 amount) external onlyRole(ISSUER_ROLE) {
        _burn(from, amount);
    }

    // ---------------------------------------------------------------------
    // ERC-165
    // ---------------------------------------------------------------------

    /**
     * @notice ERC-165 discovery for {IERC8056} and {IERC8056Scheduled}.
     * @dev Integrators SHOULD still fall back to probing `uiMultiplier()` directly,
     *      because tokens deployed before the standard existed (including the
     *      canonical Robinhood Stock Tokens) report neither interface id.
     */
    function supportsInterface(bytes4 interfaceId) public view override(AccessControl) returns (bool) {
        return interfaceId == type(IERC8056).interfaceId || interfaceId == type(IERC8056Scheduled).interfaceId
            || super.supportsInterface(interfaceId);
    }
}
