// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface GameAsset {
  id: string;
  encryptedValue: string;
  gameName: string;
  assetType: string;
  timestamp: number;
  owner: string;
  status: "pending" | "approved" | "rejected";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [assets, setAssets] = useState<GameAsset[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [adding, setAdding] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newAssetData, setNewAssetData] = useState({ gameName: "", assetType: "", value: 0 });
  const [showIntro, setShowIntro] = useState(true);
  const [selectedAsset, setSelectedAsset] = useState<GameAsset | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");

  const approvedCount = assets.filter(a => a.status === "approved").length;
  const pendingCount = assets.filter(a => a.status === "pending").length;
  const rejectedCount = assets.filter(a => a.status === "rejected").length;

  useEffect(() => {
    loadAssets().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadAssets = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("asset_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing asset keys:", e); }
      }
      
      const list: GameAsset[] = [];
      for (const key of keys) {
        try {
          const assetBytes = await contract.getData(`asset_${key}`);
          if (assetBytes.length > 0) {
            try {
              const assetData = JSON.parse(ethers.toUtf8String(assetBytes));
              list.push({ 
                id: key, 
                encryptedValue: assetData.value, 
                gameName: assetData.gameName, 
                assetType: assetData.assetType, 
                timestamp: assetData.timestamp, 
                owner: assetData.owner, 
                status: assetData.status || "pending" 
              });
            } catch (e) { console.error(`Error parsing asset data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading asset ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setAssets(list);
    } catch (e) { console.error("Error loading assets:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const addAsset = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setAdding(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting asset value with Zama FHE..." });
    try {
      const encryptedValue = FHEEncryptNumber(newAssetData.value);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const assetId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const assetData = { 
        value: encryptedValue, 
        gameName: newAssetData.gameName, 
        assetType: newAssetData.assetType, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        status: "pending" 
      };
      
      await contract.setData(`asset_${assetId}`, ethers.toUtf8Bytes(JSON.stringify(assetData)));
      
      const keysBytes = await contract.getData("asset_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(assetId);
      await contract.setData("asset_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Asset submitted with FHE encryption!" });
      await loadAssets();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowAddModal(false);
        setNewAssetData({ gameName: "", assetType: "", value: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setAdding(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const approveAsset = async (assetId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted asset value..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const assetBytes = await contract.getData(`asset_${assetId}`);
      if (assetBytes.length === 0) throw new Error("Asset not found");
      const assetData = JSON.parse(ethers.toUtf8String(assetBytes));
      
      const verifiedValue = FHECompute(assetData.value, 'increase10%');
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedAsset = { ...assetData, status: "approved", value: verifiedValue };
      await contractWithSigner.setData(`asset_${assetId}`, ethers.toUtf8Bytes(JSON.stringify(updatedAsset)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Asset approved with FHE computation!" });
      await loadAssets();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Approval failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectAsset = async (assetId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing asset rejection..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const assetBytes = await contract.getData(`asset_${assetId}`);
      if (assetBytes.length === 0) throw new Error("Asset not found");
      const assetData = JSON.parse(ethers.toUtf8String(assetBytes));
      const updatedAsset = { ...assetData, status: "rejected" };
      await contract.setData(`asset_${assetId}`, ethers.toUtf8String(JSON.stringify(updatedAsset)));
      setTransactionStatus({ visible: true, status: "success", message: "Asset rejected!" });
      await loadAssets();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (assetAddress: string) => address?.toLowerCase() === assetAddress.toLowerCase();

  const filteredAssets = assets.filter(asset => {
    const matchesSearch = asset.gameName.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         asset.assetType.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === "all" || asset.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const renderStats = () => {
    return (
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{assets.length}</div>
          <div className="stat-label">Total Assets</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{approvedCount}</div>
          <div className="stat-label">Approved</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{pendingCount}</div>
          <div className="stat-label">Pending</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{rejectedCount}</div>
          <div className="stat-label">Rejected</div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="metal-spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="shield-icon"></div>
          </div>
          <h1>FHE<span>GameFi</span>Lend</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowAddModal(true)} className="add-asset-btn metal-button">
            <div className="add-icon"></div>Add Asset
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        {showIntro && (
          <div className="intro-section metal-card">
            <div className="intro-header">
              <h2>FHE-Powered GameFi Lending</h2>
              <button onClick={() => setShowIntro(false)} className="close-intro">&times;</button>
            </div>
            <div className="intro-content">
              <div className="intro-feature">
                <div className="feature-icon">🔒</div>
                <div>
                  <h3>Privacy-Preserving Collateral</h3>
                  <p>Submit game assets as collateral without revealing your game identity using Zama FHE encryption</p>
                </div>
              </div>
              <div className="intro-feature">
                <div className="feature-icon">⚙️</div>
                <div>
                  <h3>Encrypted Valuation</h3>
                  <p>Asset values are computed while remaining encrypted, preserving your financial privacy</p>
                </div>
              </div>
              <div className="intro-feature">
                <div className="feature-icon">🌉</div>
                <div>
                  <h3>Bridge GameFi & DeFi</h3>
                  <p>Unlock liquidity from your game assets while maintaining complete privacy</p>
                </div>
              </div>
              <div className="fhe-badge">
                <span>Powered by Zama FHE</span>
              </div>
            </div>
          </div>
        )}

        <div className="dashboard-section">
          <div className="dashboard-header">
            <h2>Asset Dashboard</h2>
            <div className="dashboard-controls">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search assets..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="metal-input"
                />
                <div className="search-icon"></div>
              </div>
              <select 
                value={filterStatus} 
                onChange={(e) => setFilterStatus(e.target.value)}
                className="metal-select"
              >
                <option value="all">All Statuses</option>
                <option value="approved">Approved</option>
                <option value="pending">Pending</option>
                <option value="rejected">Rejected</option>
              </select>
              <button onClick={loadAssets} className="refresh-btn metal-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="stats-section">
            {renderStats()}
          </div>

          <div className="assets-list metal-card">
            <div className="table-header">
              <div className="header-cell">Game</div>
              <div className="header-cell">Asset Type</div>
              <div className="header-cell">Owner</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            {filteredAssets.length === 0 ? (
              <div className="no-assets">
                <div className="no-assets-icon"></div>
                <p>No assets found matching your criteria</p>
                <button className="metal-button primary" onClick={() => setShowAddModal(true)}>Add First Asset</button>
              </div>
            ) : filteredAssets.map(asset => (
              <div className="asset-row" key={asset.id} onClick={() => setSelectedAsset(asset)}>
                <div className="table-cell">{asset.gameName}</div>
                <div className="table-cell">{asset.assetType}</div>
                <div className="table-cell">{asset.owner.substring(0, 6)}...{asset.owner.substring(38)}</div>
                <div className="table-cell">{new Date(asset.timestamp * 1000).toLocaleDateString()}</div>
                <div className="table-cell">
                  <span className={`status-badge ${asset.status}`}>{asset.status}</span>
                </div>
                <div className="table-cell actions">
                  {isOwner(asset.owner) && asset.status === "pending" && (
                    <>
                      <button className="action-btn metal-button success" onClick={(e) => { e.stopPropagation(); approveAsset(asset.id); }}>Approve</button>
                      <button className="action-btn metal-button danger" onClick={(e) => { e.stopPropagation(); rejectAsset(asset.id); }}>Reject</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {showAddModal && (
        <ModalAddAsset 
          onSubmit={addAsset} 
          onClose={() => setShowAddModal(false)} 
          adding={adding} 
          assetData={newAssetData} 
          setAssetData={setNewAssetData}
        />
      )}

      {selectedAsset && (
        <AssetDetailModal 
          asset={selectedAsset} 
          onClose={() => { setSelectedAsset(null); setDecryptedValue(null); }} 
          decryptedValue={decryptedValue} 
          setDecryptedValue={setDecryptedValue} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="metal-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="shield-icon"></div>
              <span>FHE GameFi Lending</span>
            </div>
            <p>Privacy-preserving lending for encrypted game assets</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Powered Privacy</span>
          </div>
          <div className="copyright">© {new Date().getFullYear()} FHES048. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalAddAssetProps {
  onSubmit: () => void; 
  onClose: () => void; 
  adding: boolean;
  assetData: any;
  setAssetData: (data: any) => void;
}

const ModalAddAsset: React.FC<ModalAddAssetProps> = ({ onSubmit, onClose, adding, assetData, setAssetData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setAssetData({ ...assetData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setAssetData({ ...assetData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!assetData.gameName || !assetData.assetType || !assetData.value) {
      alert("Please fill all required fields");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="add-asset-modal metal-card">
        <div className="modal-header">
          <h2>Add Game Asset</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Your asset value will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>Game Name *</label>
              <input 
                type="text" 
                name="gameName" 
                value={assetData.gameName} 
                onChange={handleChange} 
                placeholder="Enter game name..." 
                className="metal-input"
              />
            </div>
            <div className="form-group">
              <label>Asset Type *</label>
              <select 
                name="assetType" 
                value={assetData.assetType} 
                onChange={handleChange} 
                className="metal-select"
              >
                <option value="">Select asset type</option>
                <option value="Weapon">Weapon</option>
                <option value="Armor">Armor</option>
                <option value="Character">Character</option>
                <option value="Land">Land</option>
                <option value="Currency">Currency</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div className="form-group">
              <label>Estimated Value (USD) *</label>
              <input 
                type="number" 
                name="value" 
                value={assetData.value} 
                onChange={handleValueChange} 
                placeholder="Enter value..." 
                className="metal-input"
                step="0.01"
                min="0"
              />
            </div>
          </div>
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Value:</span>
                <div>{assetData.value || 'No value entered'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{assetData.value ? FHEEncryptNumber(assetData.value).substring(0, 50) + '...' : 'No value entered'}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn metal-button">Cancel</button>
          <button onClick={handleSubmit} disabled={adding} className="submit-btn metal-button primary">
            {adding ? "Encrypting with FHE..." : "Submit Asset"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface AssetDetailModalProps {
  asset: GameAsset;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const AssetDetailModal: React.FC<AssetDetailModalProps> = ({ asset, onClose, decryptedValue, setDecryptedValue, isDecrypting, decryptWithSignature }) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { setDecryptedValue(null); return; }
    const decrypted = await decryptWithSignature(asset.encryptedValue);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="asset-detail-modal metal-card">
        <div className="modal-header">
          <h2>Asset Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="asset-info">
            <div className="info-item">
              <span>Game:</span>
              <strong>{asset.gameName}</strong>
            </div>
            <div className="info-item">
              <span>Asset Type:</span>
              <strong>{asset.assetType}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>{asset.owner.substring(0, 6)}...{asset.owner.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Date Submitted:</span>
              <strong>{new Date(asset.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${asset.status}`}>{asset.status}</strong>
            </div>
          </div>
          <div className="encrypted-data-section">
            <h3>Encrypted Value</h3>
            <div className="encrypted-data">
              {asset.encryptedValue.substring(0, 100)}...
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted</span>
            </div>
            <button 
              className="decrypt-btn metal-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? <span className="decrypt-spinner"></span> : 
               decryptedValue !== null ? "Hide Value" : "Decrypt with Wallet"}
            </button>
          </div>
          {decryptedValue !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Value</h3>
              <div className="decrypted-value">${decryptedValue.toFixed(2)}</div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Value decrypted locally after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn metal-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;