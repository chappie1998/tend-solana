// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ITendEligibility {
    function canTrade(address account, address underlying) external view returns (bool);
}
