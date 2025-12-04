pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract GameFiLendingFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchOpen;
    mapping(uint256 => euint32) public encryptedTotalCollateralInBatch;
    mapping(uint256 => uint256) public loanCountInBatch;

    struct LoanApplication {
        euint32 encryptedCollateralValue;
        euint32 encryptedLoanAmount;
        euint32 encryptedInterestRate;
        address borrowerAddress;
    }
    mapping(uint256 => mapping(uint256 => LoanApplication)) public batchLoans;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool indexed paused);
    event CooldownSecondsSet(uint256 indexed cooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event LoanSubmitted(address indexed borrower, uint256 indexed batchId, uint256 loanIndex);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalCollateralValue, uint256 totalLoanAmount, uint256 totalInterestRate);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosedOrInvalid();
    error InvalidCooldown();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 30; // Default cooldown
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        if (_cooldownSeconds == 0) revert InvalidCooldown();
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsSet(_cooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        isBatchOpen[currentBatchId] = true;
        encryptedTotalCollateralInBatch[currentBatchId] = FHE.asEuint32(0);
        loanCountInBatch[currentBatchId] = 0;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!isBatchOpen[currentBatchId]) revert BatchClosedOrInvalid();
        isBatchOpen[currentBatchId] = false;
        emit BatchClosed(currentBatchId);
    }

    function submitLoan(
        euint32 encryptedCollateralValue,
        euint32 encryptedLoanAmount,
        euint32 encryptedInterestRate
    ) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!isBatchOpen[currentBatchId]) revert BatchClosedOrInvalid();

        lastSubmissionTime[msg.sender] = block.timestamp;

        uint256 loanIndex = loanCountInBatch[currentBatchId]++;
        batchLoans[currentBatchId][loanIndex] = LoanApplication({
            encryptedCollateralValue: encryptedCollateralValue,
            encryptedLoanAmount: encryptedLoanAmount,
            encryptedInterestRate: encryptedInterestRate,
            borrowerAddress: msg.sender
        });

        encryptedTotalCollateralInBatch[currentBatchId] = encryptedTotalCollateralInBatch[currentBatchId].add(encryptedCollateralValue);

        emit LoanSubmitted(msg.sender, currentBatchId, loanIndex);
    }

    function requestBatchSummaryDecryption(uint256 batchId) external onlyOwner whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (isBatchOpen[batchId]) revert BatchClosedOrInvalid(); // Must be closed

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        euint32 totalCollateral = encryptedTotalCollateralInBatch[batchId];
        euint32 totalLoanAmount = FHE.asEuint32(0);
        euint32 totalInterestRate = FHE.asEuint32(0);

        for (uint256 i = 0; i < loanCountInBatch[batchId]; i++) {
            LoanApplication storage loan = batchLoans[batchId][i];
            totalLoanAmount = totalLoanAmount.add(loan.encryptedLoanAmount);
            totalInterestRate = totalInterestRate.add(loan.encryptedInterestRate);
        }
        _initIfNeeded(totalLoanAmount);
        _initIfNeeded(totalInterestRate);

        bytes32[] memory cts = new bytes32[](3);
        cts[0] = FHE.toBytes32(totalCollateral);
        cts[1] = FHE.toBytes32(totalLoanAmount);
        cts[2] = FHE.toBytes32(totalInterestRate);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });

        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        uint256 batchId = decryptionContexts[requestId].batchId;
        euint32 currentTotalCollateral = encryptedTotalCollateralInBatch[batchId];
        euint32 currentTotalLoanAmount = FHE.asEuint32(0);
        euint32 currentTotalInterestRate = FHE.asEuint32(0);

        for (uint256 i = 0; i < loanCountInBatch[batchId]; i++) {
            LoanApplication storage loan = batchLoans[batchId][i];
            currentTotalLoanAmount = currentTotalLoanAmount.add(loan.encryptedLoanAmount);
            currentTotalInterestRate = currentTotalInterestRate.add(loan.encryptedInterestRate);
        }
        _initIfNeeded(currentTotalLoanAmount);
        _initIfNeeded(currentTotalInterestRate);

        bytes32[] memory currentCts = new bytes32[](3);
        currentCts[0] = FHE.toBytes32(currentTotalCollateral);
        currentCts[1] = FHE.toBytes32(currentTotalLoanAmount);
        currentCts[2] = FHE.toBytes32(currentTotalInterestRate);

        bytes32 currentStateHash = _hashCiphertexts(currentCts);

        if (currentStateHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        try FHE.checkSignatures(requestId, cleartexts, proof) {
            // Decoding order must match cts order
            uint32 totalCollateralValue = abi.decode(cleartexts, (uint32));
            cleartexts = cleartexts[32:]; // Advance slice
            uint32 totalLoanAmountValue = abi.decode(cleartexts, (uint32));
            cleartexts = cleartexts[32:]; // Advance slice
            uint32 totalInterestRateValue = abi.decode(cleartexts, (uint32));

            decryptionContexts[requestId].processed = true;
            emit DecryptionCompleted(requestId, batchId, totalCollateralValue, totalLoanAmountValue, totalInterestRateValue);
        } catch {
            revert InvalidProof();
        }
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 val) internal {
        if (!val.isInitialized()) {
            val.init();
        }
    }

    function _requireInitialized(euint32 val) internal view {
        if (!val.isInitialized()) {
            revert("FHE: euint32 not initialized");
        }
    }
}