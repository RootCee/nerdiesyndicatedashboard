/* global BigInt */
import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  BrowserProvider,
  Contract,
  EtherscanProvider,
  JsonRpcProvider,
  formatEther,
  parseEther,
  parseUnits,
  Interface
} from "ethers";

// Import ABIs
import ERC721_ABI from "./abis/ERC721.json";
import ERC6551_REGISTRY_ABI from "./abis/ERC6551Registry.json";
// This is your ERC1155 NFT (Business) contract ABI.
import ERC1155_BUSINESSES_ABI from "./abis/NerdieBlaqSyndicateBusinesses.json";
// Import the staking contract ABI – make sure this file contains the "stake" function.
import STAKING_ABI from "./abis/BusinessStakingWithBurn.json";

// Minimal ABI for the token-bound account (TBA)
const TBA_ABI = [
  "function executeCall(address to, uint256 value, bytes data) external payable returns (bytes)",
  "function send(address payable to, uint256 amount) external payable",
  "function sendCustom(address to, uint256 amount, address erc20Contract) external",
  "function transferOwnership(address newOwner) external",
  "function owner() view returns (address)"
];

// Environment variables (ensure these are set correctly)
const ERC721_ADDRESS = process.env.REACT_APP_ERC721_ADDRESS;
const ERC6551_REGISTRY_ADDRESS = process.env.REACT_APP_ERC6551_REGISTRY_ADDRESS;
const TOKEN_BOUND_IMPLEMENTATION = process.env.REACT_APP_TOKEN_BOUND_IMPLEMENTATION;
const CHAIN_ID = Number(process.env.REACT_APP_CHAIN_ID);
const SALT = Number(process.env.REACT_APP_SALT);
const ETHERSCAN_API_KEY = process.env.REACT_APP_ETHERSCAN_API_KEY;
const ALCHEMY_URL = process.env.REACT_APP_ALCHEMY_URL;
const ERC1155_BUSINESSES_ADDRESS = process.env.REACT_APP_BUSINESS_NFT_ADDRESS;
const STAKING_CONTRACT_ADDRESS = process.env.REACT_APP_STAKING_CONTRACT_ADDRESS;
console.log("Business NFT Address:", ERC1155_BUSINESSES_ADDRESS);
console.log("Staking Contract Address:", STAKING_CONTRACT_ADDRESS);

// Mint price for ERC721 NFT (in ETH)
const MINT_PRICE = "0.01";

// Fallback business prices (if contract call fails)
const FALLBACK_BUSINESS_PRICES = {
  1: parseEther("0.01"),
  2: parseEther("0.015"),
  3: parseEther("0.012"),
  4: parseEther("0.02"),
  5: parseEther("0.025")
};

// Static mapping for business NFT details (name and image placeholders)
// Place your images in the public/images folder.
const businessInfo = {
  1: { name: "Retail Business", image: "/images/retail.png" },
  2: { name: "Tech Startup", image: "/images/tech.png" },
  3: { name: "Entertainment Venue", image: "/images/entertainment.png" },
  4: { name: "Manufacturing Unit", image: "/images/manufacturing.png" },
  5: { name: "Financial Institution", image: "/images/financial.png" }
};

///////////////////////////
// Helper Functions
///////////////////////////

// Helper to switch the gateway from ipfs.io to Pinata’s gateway
function updateIPFSGateway(url) {
  if (!url) return url;
  return url.replace("ipfs.io", "gateway.pinata.cloud");
}

async function getGasPriceFromEtherscan(apiKey) {
  try {
    const url = `https://api.basescan.org/api?module=proxy&action=eth_gasPrice&apikey=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();
    console.log("Etherscan gas price (hex):", data.result);
    return BigInt(data.result);
  } catch (error) {
    console.error("Error fetching gas price from Etherscan:", error);
    return parseEther("0.00000001").toBigInt();
  }
}

async function fetchHistoricalDataCoinGecko(coinId) {
  try {
    const response = await fetch(`/api/coinData?coin=bitcoin`);
    const data = await response.json();

    if (data.error || !data.prices) {
      console.error("Error in API response:", data.error || "No price data");
      return null;
    }

    return data.prices.map(point => point[1]); // Return prices only
  } catch (error) {
    console.error("Error fetching historical data from backend:", error);
    return null;
  }
}

function calculateSMA(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((acc, val) => acc + val, 0) / period;
}
function calculateFMA(prices, period) {
  return calculateSMA(prices, period);
}
function calculateRSI(prices, period) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

async function fetchBusinessBalance(businessType, walletAddr) {
  try {
    const provider = new JsonRpcProvider(ALCHEMY_URL);
    const erc1155 = new Contract(ERC1155_BUSINESSES_ADDRESS, ERC1155_BUSINESSES_ABI, provider);
    console.log(`Fetching balance for token id ${businessType} at address ${walletAddr}`);
    const balance = await erc1155.balanceOf(walletAddr, businessType);
    console.log(`Balance for token id ${businessType} at ${walletAddr}: ${balance.toString()}`);
    return balance.toString();
  } catch (error) {
    console.error("Error fetching business NFT balance:", error);
    return "0";
  }
}

// NEW: Function to fetch remaining supply for a business type
async function fetchRemainingSupply(businessType) {
  try {
    const provider = new JsonRpcProvider(ALCHEMY_URL);
    const erc1155 = new Contract(ERC1155_BUSINESSES_ADDRESS, ERC1155_BUSINESSES_ABI, provider);
    const max = await erc1155.maxSupply(businessType);
    const minted = await erc1155.totalMinted(businessType);
    // Convert to BigInt (using toString() for safe conversion)
    const remaining = BigInt(max.toString()) - BigInt(minted.toString());
    return remaining.toString();
  } catch (error) {
    console.error(`Error fetching remaining supply for business type ${businessType}:`, error);
    return "0";
  }
}

///////////////////////////
// Main Component
///////////////////////////
function App() {
  // Basic state variables
  const [provider, setProvider] = useState(null);
  const [readProvider, setReadProvider] = useState(null);
  const [alchemyProvider, setAlchemyProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [userAddress, setUserAddress] = useState("");
  const [nfts, setNfts] = useState([]);
  const [tokenAccounts, setTokenAccounts] = useState({});
  const [tokenMetadata, setTokenMetadata] = useState({});
  const [status, setStatus] = useState("");
  const [mintQuantity, setMintQuantity] = useState(1);
  const [selectedNFT, setSelectedNFT] = useState(null);
  const [sendRecipient, setSendRecipient] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [selectedSendToken, setSelectedSendToken] = useState("ETH");
  const [mintedCount, setMintedCount] = useState(0);
  const [maxSupply, setMaxSupply] = useState(0);
  const collectionImageUrl = "/collection.png";

  // Business NFT minting state
  const [businessType, setBusinessType] = useState(1);
  const [businessQuantity, setBusinessQuantity] = useState(1);
  const [businessBalance, setBusinessBalance] = useState("0");
  const [businessStatus, setBusinessStatus] = useState("");

  // New state for remaining supply per business type
  const [remainingSupplies, setRemainingSupplies] = useState({});

  // Staking state – stakingType corresponds to the tokenId (business type) to stake
  const [stakingType, setStakingType] = useState(1);
  const [stakingAmount, setStakingAmount] = useState(1);
  const [pendingReward, setPendingReward] = useState("0");
  // New state to store the total staked count (amount from stake record)
  const [stakedCount, setStakedCount] = useState("0");

  // Display states for all 5 business types
  const [businessPrices, setBusinessPrices] = useState({});
  const [allBusinessBalances, setAllBusinessBalances] = useState({});

  // Moving Average Bot States (unchanged)
  const [botAddresses, setBotAddresses] = useState(["", "", "", "", ""]);
  const [smaPeriodInput, setSmaPeriodInput] = useState(21);
  const [fmaPeriodInput, setFmaPeriodInput] = useState(7);
  const [rsiPeriodInput, setRsiPeriodInput] = useState(14);
  const [botSignals, setBotSignals] = useState({});
  const [botRunning, setBotRunning] = useState(false);
  const botInterval = useRef(null);

  const updateBotAddress = (index, value) => {
    const newAddresses = [...botAddresses];
    newAddresses[index] = value;
    setBotAddresses(newAddresses);
  };

  // ----------------------------
  // Staking Functions (using connected user wallet)
  // ----------------------------
  async function stakeNFT() {
    if (!signer || !selectedNFT) {
      alert("Please connect your wallet and select an NFT.");
      return;
    }
    try {
      const stakingContract = new Contract(STAKING_CONTRACT_ADDRESS, STAKING_ABI, signer);
      const gasPrice = await getGasPriceFromEtherscan(ETHERSCAN_API_KEY);
      const overrides = { gasLimit: 300000, gasPrice: gasPrice.toString(), value: "0" };
      const tx = await stakingContract.stake(stakingType, stakingAmount, overrides);
      await tx.wait();
      setStatus("Stake successful!");
      fetchPendingReward();
    } catch (error) {
      console.error("Error staking NFT:", error);
      setStatus("Error staking NFT");
    }
  }

  async function unstakeNFT() {
    if (!signer || !selectedNFT) {
      alert("Please connect your wallet and select an NFT.");
      return;
    }
    try {
      const stakingContract = new Contract(STAKING_CONTRACT_ADDRESS, STAKING_ABI, signer);
      const gasPrice = await getGasPriceFromEtherscan(ETHERSCAN_API_KEY);
      const overrides = { gasLimit: 300000, gasPrice: gasPrice.toString(), value: "0" };
      const tx = await stakingContract.unstake(stakingType, stakingAmount, overrides);
      await tx.wait();
      setStatus("Unstake successful!");
      fetchPendingReward();
    } catch (error) {
      console.error("Error unstaking NFT:", error);
      setStatus("Error unstaking NFT");
    }
  }

  async function claimReward() {
    if (!signer || !selectedNFT) {
      alert("Please connect your wallet and select an NFT.");
      return;
    }
    try {
      const stakingContract = new Contract(STAKING_CONTRACT_ADDRESS, STAKING_ABI, signer);
      const gasPrice = await getGasPriceFromEtherscan(ETHERSCAN_API_KEY);
      const overrides = { gasLimit: 300000, gasPrice: gasPrice.toString(), value: "0" };
      const tx = await stakingContract.claimReward(stakingType, overrides);
      await tx.wait();
      setStatus("Reward claimed to your wallet!");
      fetchPendingReward();
    } catch (error) {
      console.error("Error claiming reward:", error);
      setStatus("Error claiming reward");
    }
  }

  const fetchPendingReward = useCallback(async () => {
    if (!selectedNFT || !userAddress) return;
    try {
      const providerInstance = new JsonRpcProvider(ALCHEMY_URL);
      const stakingContract = new Contract(STAKING_CONTRACT_ADDRESS, STAKING_ABI, providerInstance);
      // Use the connected wallet (userAddress) to fetch the stake record
      const stakeInfo = await stakingContract.stakes(userAddress, stakingType);
      setPendingReward(formatEther(stakeInfo.pendingReward));
      setStakedCount(stakeInfo.amount.toString());
    } catch (error) {
      console.error("Error fetching pending reward:", error);
    }
  }, [selectedNFT, userAddress, stakingType]);

  // ----------------------------
  // Minting and TBA Functions (unchanged except Business NFT mint)
  // ----------------------------
  // Updated Business NFT Mint: mint directly to the connected wallet (EOA)
  // Updated mint functions for NerdieBlaqSyndicateBusinesses.sol

// ───────────────────────────────────────────────────────────────
// Mint Business NFT (bulk) to the user’s EOA, just like Remix
// ───────────────────────────────────────────────────────────────
async function mintBusinessNFT() {
  if (!signer || !selectedNFT) {
    return alert("Please connect your wallet and select an NFT.");
  }

  // 1) Instantiate contract
  const erc1155 = new Contract(
    ERC1155_BUSINESSES_ADDRESS,
    ERC1155_BUSINESSES_ABI,
    signer
  );

  // 2) Get on-chain price (BigNumber) and compute totalCost
  let priceBN;
  try {
    priceBN = await erc1155.businessPrice(businessType);
  } catch {
    priceBN = FALLBACK_BUSINESS_PRICES[businessType];
  }
  const totalCost = priceBN.mul(businessQuantity);

  // 3) Optional logging to debug
  console.log({
    businessType,
    businessQuantity,
    price: priceBN.toString(),
    totalCost: totalCost.toString()
  });

  // 4) Send the exact same call you made in Remix:
  try {
    const tx = await erc1155.mintBusiness(
      businessType,      // uint256 tokenId
      businessQuantity,  // uint256 amount
      userAddress,       // address recipient
      { value: totalCost }
    );
    await tx.wait();

    setBusinessStatus("Business NFT minted successfully!");
    const bal = await fetchBusinessBalance(businessType, userAddress);
    setBusinessBalance(bal);
    const remaining = await fetchRemainingSupply(businessType);
    setRemainingSupplies(prev => ({ ...prev, [businessType]: remaining }));
  } catch (err) {
    console.error("Mint failed:", err);
    setBusinessStatus(`Mint failed: ${err.reason || err.message}`);
  }
}


// ───────────────────────────────────────────────────────────────
// Mint a single Business NFT (type-specific)
// ───────────────────────────────────────────────────────────────
async function mintBusinessForType(type) {
  if (!signer) {
    return alert("Please connect your wallet first.");
  }

  const erc1155 = new Contract(
    ERC1155_BUSINESSES_ADDRESS,
    ERC1155_BUSINESSES_ABI,
    signer
  );

  let priceBN;
  try {
    priceBN = await erc1155.businessPrice(type);
  } catch {
    priceBN = FALLBACK_BUSINESS_PRICES[type];
  }
  const totalCost = priceBN; // minting 1

  console.log({ type, price: priceBN.toString(), totalCost: totalCost.toString() });

  try {
    const tx = await erc1155.mintBusiness(
      type,         // uint256 tokenId
      1,            // uint256 amount
      userAddress,  // address recipient
      { value: totalCost }
    );
    await tx.wait();

    setBusinessStatus(`Business NFT type ${type} minted successfully!`);
    const bal = await fetchBusinessBalance(type, userAddress);
    setBusinessBalance(bal);
    const remaining = await fetchRemainingSupply(type);
    setRemainingSupplies(prev => ({ ...prev, [type]: remaining }));
  } catch (err) {
    console.error("Mint failed:", err);
    setBusinessStatus(`Mint failed: ${err.reason || err.message}`);
  }
}

  const fetchERC20Metadata = async (contractAddress) => {
    try {
      const payload = {
        jsonrpc: "2.0",
        method: "alchemy_getTokenMetadata",
        params: [contractAddress],
        id: 1,
      };
      const response = await fetch(ALCHEMY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await response.json();
      return json.result;
    } catch (error) {
      console.error(`Error fetching metadata for ${contractAddress}:`, error);
      return null;
    }
  };

  const fetchTokenBoundAccount = useCallback(async (tokenId) => {
    if (!readProvider || !alchemyProvider) return;
    try {
      const registry = new Contract(ERC6551_REGISTRY_ADDRESS, ERC6551_REGISTRY_ABI, readProvider);
      const predictedAddress = await registry.account(
        TOKEN_BOUND_IMPLEMENTATION,
        CHAIN_ID,
        ERC721_ADDRESS,
        tokenId,
        SALT
      );
      console.log(`Predicted address for token ${tokenId}:`, predictedAddress);
      const code = await alchemyProvider.getCode(predictedAddress);
      const balanceWei = await alchemyProvider.getBalance(predictedAddress);
      const balance = formatEther(balanceWei);
      console.log(`ETH Balance for token ${tokenId} at ${predictedAddress}:`, balance);
      const deployed = (code && code !== "0x");
      let tbaOwner = "";
      if (deployed) {
        try {
          const ownerSelector = "0x8da5cb5b";
          const ret = await alchemyProvider.call({ to: predictedAddress, data: ownerSelector });
          if (ret === "0x" || ret.length === 0) {
            tbaOwner = "Not Deployed";
          } else {
            const tbaInterface = new Interface(TBA_ABI);
            tbaOwner = tbaInterface.decodeFunctionResult("owner", ret)[0];
          }
          console.log(`TBA Owner for token ${tokenId}:`, tbaOwner);
        } catch (ownerError) {
          console.error("Error fetching TBA owner:", ownerError);
          tbaOwner = "Unknown";
        }
      } else {
        tbaOwner = "Not Deployed";
      }
      let erc20Tokens = [];
      try {
        const payload = {
          jsonrpc: "2.0",
          method: "alchemy_getTokenBalances",
          params: [predictedAddress],
          id: 1,
        };
        const response = await fetch(ALCHEMY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await response.json();
        erc20Tokens = (json.result && json.result.tokenBalances) || [];
      } catch (erc20Error) {
        console.error(`Error fetching ERC20 balances for ${predictedAddress}:`, erc20Error);
      }
      for (const token of erc20Tokens) {
        if (!tokenMetadata[token.contractAddress]) {
          const meta = await fetchERC20Metadata(token.contractAddress);
          setTokenMetadata((prev) => ({ ...prev, [token.contractAddress]: meta }));
        }
      }
      setTokenAccounts((prev) => ({
        ...prev,
        [tokenId]: { predicted: predictedAddress, deployed, balance, erc20: erc20Tokens, tbaOwner }
      }));
    } catch (error) {
      console.error("Error in fetchTokenBoundAccount:", error);
      setTokenAccounts((prev) => ({
        ...prev,
        [tokenId]: { predicted: null, deployed: false, balance: "0.0", erc20: [], tbaOwner: "" }
      }));
    }
  }, [readProvider, alchemyProvider, tokenMetadata]);

  const fetchNFTs = useCallback(async (owner, providerInstance) => {
    try {
      const erc721 = new Contract(ERC721_ADDRESS, ERC721_ABI, providerInstance);
      const totalMinted = Number(await erc721.totalSupply());
      setMintedCount(totalMinted);
      const max = Number(await erc721.MAX_SUPPLY());
      setMaxSupply(max);
      const nftPromises = [];
      for (let tokenId = 0; tokenId < totalMinted; tokenId++) {
        nftPromises.push(
          (async () => {
            try {
              const tokenOwner = await erc721.ownerOf(tokenId);
              if (tokenOwner.toLowerCase() === owner.toLowerCase()) {
                let tokenURI = await erc721.tokenURI(tokenId);
                tokenURI = updateIPFSGateway(tokenURI);
                let imageUrl = "";
                try {
                  const response = await fetch(tokenURI);
                  const metadata = await response.json();
                  imageUrl = updateIPFSGateway(metadata.image);
                } catch (metaError) {
                  console.error(`Error fetching metadata for token ${tokenId}:`, metaError);
                }
                return { tokenId: tokenId.toString(), tokenURI, image: imageUrl, owner: tokenOwner };
              }
              return null;
            } catch (innerError) {
              if (!innerError.message.includes("ERC721NonexistentToken")) {
                console.error(`Error fetching token ${tokenId}:`, innerError);
              }
              return null;
            }
          })()
        );
      }
      const nftList = (await Promise.all(nftPromises)).filter((nft) => nft !== null);
      setNfts(nftList);
      nftList.forEach((nft) => {
        fetchTokenBoundAccount(nft.tokenId);
      });
    } catch (error) {
      console.error("Error fetching NFTs:", error);
      setStatus("Error fetching NFTs");
    }
  }, [fetchTokenBoundAccount]);

  // Fetch business prices for types 1-5
  useEffect(() => {
    async function fetchAllPrices() {
      let prices = {};
      try {
        const provider = new JsonRpcProvider(ALCHEMY_URL);
        const erc1155Business = new Contract(ERC1155_BUSINESSES_ADDRESS, ERC1155_BUSINESSES_ABI, provider);
        for (let i = 1; i <= 5; i++) {
          const price = await erc1155Business.businessPrice(i);
          prices[i] = formatEther(price);
        }
      } catch (error) {
        console.error("Error fetching business prices, using fallback", error);
        for (let i = 1; i <= 5; i++) {
          prices[i] = formatEther(FALLBACK_BUSINESS_PRICES[i]);
        }
      }
      setBusinessPrices(prices);
    }
    fetchAllPrices();
  }, []);

  // Fetch all business NFT balances (owned by the TBA of the selected NFT)
  useEffect(() => {
    async function fetchAllBalances() {
      if (selectedNFT && tokenAccounts[selectedNFT.tokenId] && tokenAccounts[selectedNFT.tokenId].predicted) {
        let balances = {};
        for (let i = 1; i <= 5; i++) {
          const bal = await fetchBusinessBalance(i, tokenAccounts[selectedNFT.tokenId].predicted);
          balances[i] = bal;
        }
        setAllBusinessBalances(balances);
      }
    }
    fetchAllBalances();
  }, [selectedNFT, tokenAccounts]);

  // New: Fetch remaining supply for all business types and store in state
  useEffect(() => {
    async function fetchAllRemainingSupplies() {
      let supplies = {};
      for (let i = 1; i <= 5; i++) {
        supplies[i] = await fetchRemainingSupply(i);
      }
      setRemainingSupplies(supplies);
    }
    fetchAllRemainingSupplies();
  }, []); // You could also refresh this periodically if needed

  useEffect(() => {
    const etherscanProv = new EtherscanProvider("base", ETHERSCAN_API_KEY);
    setReadProvider(etherscanProv);
    const alchProvider = new JsonRpcProvider(ALCHEMY_URL);
    alchProvider.batchMaxCount = 1;
    setAlchemyProvider(alchProvider);
  }, [userAddress]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (userAddress && provider) {
        console.log("Polling NFTs...");
        fetchNFTs(userAddress, provider);
        if (
          selectedNFT &&
          tokenAccounts[selectedNFT.tokenId] &&
          tokenAccounts[selectedNFT.tokenId].predicted
        ) {
          fetchBusinessBalance(businessType, tokenAccounts[selectedNFT.tokenId].predicted)
            .then((bal) => setBusinessBalance(bal));
          fetchPendingReward();
          // Optionally, also refresh remaining supplies
          (async () => {
            const supplies = {};
            for (let i = 1; i <= 5; i++) {
              supplies[i] = await fetchRemainingSupply(i);
            }
            setRemainingSupplies(supplies);
          })();
        }
      }
    }, 15000);
    return () => clearInterval(interval);
  }, [userAddress, provider, fetchNFTs, businessType, selectedNFT, tokenAccounts, fetchPendingReward]);

  useEffect(() => {
    if (!provider || !userAddress) return;
    const erc721 = new Contract(ERC721_ADDRESS, ERC721_ABI, provider);
    const transferHandler = (from, to, tokenId) => {
      console.log(`Transfer detected: token ${tokenId} from ${from} to ${to}`);
      if (
        from.toLowerCase() === userAddress.toLowerCase() ||
        to.toLowerCase() === userAddress.toLowerCase()
      ) {
        fetchNFTs(userAddress, provider);
      }
    };
    erc721.on("Transfer", transferHandler);
    return () => {
      erc721.off("Transfer", transferHandler);
    };
  }, [provider, userAddress, fetchNFTs]);

  const connectWallet = async () => {
    if (!window.ethereum) {
      alert("Please install MetaMask!");
      return;
    }
    try {
      const web3Provider = new BrowserProvider(window.ethereum);
      await web3Provider.send("eth_requestAccounts", []);
      const signer = await web3Provider.getSigner();
      const address = await signer.getAddress();
      setProvider(web3Provider);
      setSigner(signer);
      setUserAddress(address);
      fetchNFTs(address, web3Provider);
    } catch (error) {
      console.error("Error connecting wallet:", error);
      setStatus("Error connecting wallet");
    }
  };

  const mintNFT = async () => {
    if (!signer) {
      alert("Please connect your wallet first.");
      return;
    }
    try {
      const erc721 = new Contract(ERC721_ADDRESS, ERC721_ABI, signer);
      const totalCost = parseEther((Number(MINT_PRICE) * mintQuantity).toString());
      setStatus("Minting NFT(s)...");
      const tx = await erc721.mint(userAddress, mintQuantity, { value: totalCost });
      await tx.wait();
      setStatus("Mint successful!");
      fetchNFTs(userAddress, provider);
    } catch (error) {
      console.error("Error minting NFT:", error);
      setStatus("Error minting NFT");
    }
  };

  // ──────────────────────────────────────────────────────────────────────────────
// Replace your existing createTokenBoundAccount with this:
const createTokenBoundAccount = async (tokenId) => {
  if (!signer) {
    alert("Please connect your wallet first.");
    return;
  }

  try {
    setStatus("Creating token-bound account…");

    // 1) Your deployed implementation address on Base:
    const impl = TOKEN_BOUND_IMPLEMENTATION;
    // 2) Base mainnet chainId:
    const chainId = CHAIN_ID;
    // 3) Your ERC-721 contract address:
    const nftContract = ERC721_ADDRESS;
    // 4) The token ID you want to bind:
    const tid = tokenId;
    // 5) Your chosen salt:
    const salt = SALT;
    // 6) **Explicit** initData—even if empty:
    const initData = "0x";

    console.log(
      "createAccount args:",
      impl,
      chainId,
      nftContract,
      tid,
      salt,
      initData
    );
    // You should see six primitive values logged above.

    // 7) Finally, the overrides object
    const overrides = { gasLimit: 1_000_000 };

    const registry = new Contract(
      ERC6551_REGISTRY_ADDRESS,
      ERC6551_REGISTRY_ABI,
      signer
    );

    // **Pass exactly 7 parameters** here—
    // the 6 real ones, then overrides last.
    const tx = await registry.createAccount(
      impl,        // 1
      chainId,     // 2
      nftContract, // 3
      tid,         // 4
      salt,        // 5
      initData,    // 6
      overrides    // 7
    );

    await tx.wait();
    setStatus(`ERC-6551 account for #${tokenId} created!`);
    fetchTokenBoundAccount(tokenId);
  } catch (error) {
    console.error("Error creating token-bound account:", error);
    setStatus("Error creating token-bound account");
  }
};

  const sendFundsFromTBA = async (tokenId, recipient, amount) => {
    if (!signer) {
      alert("Please connect your wallet first.");
      return;
    }
    try {
      const accountData = tokenAccounts[tokenId];
      if (!accountData || !accountData.deployed) {
        setStatus("Token-bound account not active.");
        return;
      }
      if (selectedSendToken === "ETH") {
        const tbaBalance = parseEther(accountData.balance);
        const requestedValue = parseEther(amount);
        console.log("TBA Balance:", tbaBalance.toString(), "Requested:", requestedValue.toString());
        if (tbaBalance.lt(requestedValue)) {
          setStatus("Insufficient TBA funds.");
          return;
        }
        const tbaContract = new Contract(accountData.predicted, TBA_ABI, signer);
        const gasPrice = await getGasPriceFromEtherscan(ETHERSCAN_API_KEY);
        const overrides = { gasLimit: 200000, gasPrice: gasPrice.toString() };
        setStatus(`Sending ${amount} ETH to ${recipient} from TBA...`);
        const tx = await tbaContract.send(recipient, parseEther(amount), overrides);
        await tx.wait();
        setStatus("ETH sent successfully!");
      } else {
        const meta = tokenMetadata[selectedSendToken] || { decimals: 18 };
        const decimals = meta.decimals || 18;
        const tbaContract = new Contract(accountData.predicted, TBA_ABI, signer);
        const gasPrice = await getGasPriceFromEtherscan(ETHERSCAN_API_KEY);
        const overrides = { gasLimit: 200000, gasPrice: gasPrice.toString() };
        setStatus(`Sending ERC20 token from TBA to ${recipient}...`);
        const tx = await tbaContract.sendCustom(
          recipient,
          parseUnits(amount, decimals),
          selectedSendToken,
          overrides
        );
        await tx.wait();
        setStatus("ERC20 token sent successfully!");
      }
      fetchTokenBoundAccount(tokenId);
    } catch (error) {
      console.error("Error sending funds from TBA:", error);
      setStatus("Error sending funds from TBA");
    }
  };

  const withdrawFundsToOwner = async (tokenId) => {
    if (!signer) {
      alert("Please connect your wallet first.");
      return;
    }
    try {
      const erc721 = new Contract(ERC721_ADDRESS, ERC721_ABI, readProvider);
      const nftOwner = await erc721.ownerOf(tokenId);
      console.log(`NFT Owner for token ${tokenId}:`, nftOwner);
      const accountData = tokenAccounts[tokenId];
      if (!accountData || !accountData.deployed) {
        setStatus("Token-bound account not active.");
        return;
      }
      const tbaContract = new Contract(accountData.predicted, TBA_ABI, signer);
      if (selectedSendToken === "ETH") {
        const gasPrice = await getGasPriceFromEtherscan(ETHERSCAN_API_KEY);
        const overrides = { gasLimit: 200000, gasPrice: gasPrice.toString() };
        setStatus(`Withdrawing ${sendAmount} ETH to NFT owner ${nftOwner}...`);
        const tx = await tbaContract.send(nftOwner, parseEther(sendAmount), overrides);
        await tx.wait();
        setStatus("ETH withdrawn successfully!");
      } else {
        const meta = tokenMetadata[selectedSendToken] || { decimals: 18 };
        const decimals = meta.decimals || 18;
        const gasPrice = await getGasPriceFromEtherscan(ETHERSCAN_API_KEY);
        const overrides = { gasLimit: 200000, gasPrice: gasPrice.toString() };
        setStatus(`Withdrawing ERC20 token to NFT owner ${nftOwner}...`);
        const tx = await tbaContract.sendCustom(
          nftOwner,
          parseUnits(sendAmount, decimals),
          selectedSendToken,
          overrides
        );
        await tx.wait();
        setStatus("ERC20 token withdrawn successfully!");
      }
      fetchTokenBoundAccount(tokenId);
    } catch (error) {
      console.error("Error withdrawing funds:", error);
      setStatus("Error withdrawing funds");
    }
  };

  // ----------------------------
  // Moving Average Bot Section (unchanged)
  // ----------------------------
  const startMovingAverageBot = () => {
    const validCoinIds = botAddresses.filter(addr => addr.trim() !== "");
    if (validCoinIds.length === 0) {
      setBotSignals({ general: "No coin IDs entered." });
      return;
    }
    setBotRunning(true);
    setStatus("Bot started.");
    botInterval.current = setInterval(async () => {
      const newSignals = {};
      for (const coinId of validCoinIds) {
        const historicalPrices = await fetchHistoricalDataCoinGecko(coinId);
        if (!historicalPrices || historicalPrices.length === 0) {
          newSignals[coinId] = "No historical data.";
          continue;
        }
        const sma = calculateSMA(historicalPrices, smaPeriodInput);
        const fma = calculateFMA(historicalPrices, fmaPeriodInput);
        const rsi = calculateRSI(historicalPrices, rsiPeriodInput);
        let signal = "Hold";
        if (fma !== null && sma !== null && rsi !== null) {
          if (fma > sma && rsi < 30) signal = "Buy";
          else if (fma < sma && rsi > 70) signal = "Sell";
        }
        const latestPrice = historicalPrices[historicalPrices.length - 1];
        newSignals[coinId] = `Price: ${latestPrice.toFixed(2)} | FMA: ${fma ? fma.toFixed(2) : "N/A"} | SMA: ${sma ? sma.toFixed(2) : "N/A"} | RSI: ${rsi ? rsi.toFixed(2) : "N/A"} → ${signal}`;
      }
      setBotSignals(newSignals);
    }, 10000);
  };

  const stopMovingAverageBot = () => {
    setBotRunning(false);
    clearInterval(botInterval.current);
    setStatus("Bot stopped.");
    setBotSignals({});
  };

  return (
    <div style={{ padding: "2rem", fontFamily: "Arial, sans-serif" }}>
      <h1>Nerdie Blaq Syndicate NFT Dashboard</h1>
      <p>Minted: {mintedCount} / {maxSupply}</p>
      <div style={{ marginBottom: "2rem" }}>
        <img src={collectionImageUrl} alt="Collection" style={{ width: "150px", height: "auto" }} />
      </div>
      {!userAddress ? (
        <button onClick={connectWallet}>Connect Wallet</button>
      ) : (
        <>
          {/* ERC721 Minting Section */}
          <div style={{ marginBottom: "2rem", padding: "1rem", border: "1px solid #ccc" }}>
            <h3>Mint a New NFT</h3>
            <label>
              Quantity:{" "}
              <input type="number" min="1" value={mintQuantity} onChange={(e) => setMintQuantity(Number(e.target.value))} />
            </label>
            <button onClick={mintNFT} style={{ marginLeft: "1rem" }}>Mint NFT</button>
            <button onClick={() => fetchNFTs(userAddress, provider)} style={{ marginLeft: "1rem" }}>Refresh NFTs</button>
          </div>
          {/* NFT List and Details Section */}
          <div style={{ display: "flex" }}>
            <div style={{ width: "30%", borderRight: "1px solid #ccc", paddingRight: "1rem" }}>
              <h2>Your NFTs</h2>
              {nfts.length === 0 ? (
                <p>No NFTs found for this wallet.</p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0 }}>
                  {nfts.map((nft, idx) => (
                    <li key={idx}
                      onClick={() => setSelectedNFT(nft)}
                      style={{
                        marginBottom: "1rem",
                        padding: "0.5rem",
                        border: "1px solid #ddd",
                        cursor: "pointer",
                        backgroundColor: selectedNFT && selectedNFT.tokenId === nft.tokenId ? "#eef" : "#fff"
                      }}
                    >
                      <p><strong>Token ID:</strong> {nft.tokenId}</p>
                      {nft.image && (
                        <img src={nft.image} alt={`NFT ${nft.tokenId}`} style={{ width: "100%", height: "auto" }} />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div style={{ width: "70%", paddingLeft: "1rem" }}>
              {selectedNFT ? (
                <div style={{ border: "1px solid #ddd", padding: "1rem" }}>
                  <h2>NFT Details</h2>
                  <p><strong>Token ID:</strong> {selectedNFT.tokenId}</p>
                  <p><strong>NFT Owner:</strong> {selectedNFT.owner}</p>
                  {selectedNFT.image && (
                    <img src={selectedNFT.image} alt={`NFT ${selectedNFT.tokenId}`} style={{ width: "300px", height: "auto" }} />
                  )}
                  {tokenAccounts[selectedNFT.tokenId] ? (
                    <>
                      <p><strong>Token-bound Address:</strong> {tokenAccounts[selectedNFT.tokenId].predicted}</p>
                      <p><strong>ETH Balance of TBA:</strong> {tokenAccounts[selectedNFT.tokenId].balance} ETH</p>
                      {tokenAccounts[selectedNFT.tokenId].tbaOwner && (
                        <p><strong>TBA Controller:</strong> {tokenAccounts[selectedNFT.tokenId].tbaOwner}</p>
                      )}
                      {tokenAccounts[selectedNFT.tokenId].erc20 && tokenAccounts[selectedNFT.tokenId].erc20.length > 0 && (
                        <div>
                          <h4>ERC20 Tokens Held:</h4>
                          <ul>
                            {tokenAccounts[selectedNFT.tokenId].erc20.map((token, index) => {
                              const balanceBig = BigInt(token.tokenBalance);
                              const formattedTokenBalance = formatEther(balanceBig);
                              const meta = tokenMetadata[token.contractAddress];
                              const displayName = meta ? `${meta.name} (${meta.symbol})` : token.contractAddress;
                              return <li key={index}><strong>{displayName}:</strong> {formattedTokenBalance}</li>;
                            })}
                          </ul>
                        </div>
                      )}
                      {tokenAccounts[selectedNFT.tokenId].deployed ? (
                        <p style={{ color: "green" }}>Account Active</p>
                      ) : (
                        <p style={{ color: "red" }}>Account Not Deployed</p>
                      )}
                      {!tokenAccounts[selectedNFT.tokenId].deployed && (
                        <button onClick={() => createTokenBoundAccount(selectedNFT.tokenId)} style={{ marginTop: "1rem" }}>
                          Create ERC6551 Account
                        </button>
                      )}
                      {/* Business NFT Mint Section */}
                      <div style={{ marginTop: "1rem", padding: "1rem", borderTop: "1px solid #ccc" }}>
                        <h4>Mint Business NFT</h4>
                        <div>
                          <label>
                            Business Type (number 1-5):{" "}
                            <input
                              type="number"
                              min="1"
                              max="5"
                              value={businessType}
                              onChange={(e) => setBusinessType(Number(e.target.value))}
                            />
                          </label>
                        </div>
                        <div>
                          <label>
                            Quantity:{" "}
                            <input
                              type="number"
                              min="1"
                              value={businessQuantity}
                              onChange={(e) => setBusinessQuantity(Number(e.target.value))}
                            />
                          </label>
                        </div>
                        <button onClick={mintBusinessNFT} style={{ marginTop: "1rem" }}>
                          Mint Business NFT (Bulk)
                        </button>
                        <p style={{ marginTop: "1rem" }}>
                          <strong>Business NFT Balance (Type {businessType}):</strong> {businessBalance}
                        </p>
                        {/* Display remaining supply for the selected type */}
                        <p style={{ marginTop: "0.5rem" }}>
                          <strong>Remaining Supply:</strong> {remainingSupplies[businessType] || "Loading..."}
                        </p>
                        {businessStatus && (
                          <p style={{ marginTop: "1rem", color: "blue" }}>
                            <strong>Status:</strong> {businessStatus}
                          </p>
                        )}
                      </div>
                      {/* Display All 5 Business NFTs with Mint Button */}
                      <div style={{ marginTop: "1rem", border: "1px solid #ccc", padding: "1rem" }}>
                        <h3>Your Business NFTs</h3>
                        <div style={{ display: "flex", flexWrap: "wrap" }}>
                          {[1, 2, 3, 4, 5].map((type) => (
                            <div key={type} style={{ margin: "0.5rem", padding: "0.5rem", border: "1px solid #ddd", width: "200px", textAlign: "center" }}>
                              <img src={businessInfo[type].image} alt={businessInfo[type].name} style={{ width: "100%", height: "auto" }} />
                              <h4>{businessInfo[type].name}</h4>
                              <p><strong>Price:</strong> {businessPrices[type] ? `${businessPrices[type]} ETH` : "Loading..."}</p>
                              <p><strong>Owned:</strong> {allBusinessBalances[type] !== undefined ? allBusinessBalances[type] : "Loading..."}</p>
                              <p><strong>Remaining:</strong> {remainingSupplies[type] || "Loading..."}</p>
                              <button onClick={() => mintBusinessForType(type)} style={{ marginTop: "0.5rem" }}>
                                Mint
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                      {/* Staking Section */}
                      <div style={{ marginTop: "1rem", border: "1px solid #ccc", padding: "1rem" }}>
                        <h3>Staking</h3>
                        <div>
                          <label>
                            Business Type to Stake:{" "}
                            <input
                              type="number"
                              min="1"
                              max="5"
                              value={stakingType}
                              onChange={(e) => setStakingType(Number(e.target.value))}
                            />
                          </label>
                        </div>
                        <div>
                          <label>
                            Amount to Stake:{" "}
                            <input
                              type="number"
                              min="1"
                              value={stakingAmount}
                              onChange={(e) => setStakingAmount(Number(e.target.value))}
                            />
                          </label>
                        </div>
                        <button onClick={stakeNFT} style={{ marginTop: "1rem" }}>Stake NFT</button>
                        <button onClick={unstakeNFT} style={{ marginLeft: "1rem" }}>Unstake NFT</button>
                        <button onClick={claimReward} style={{ marginLeft: "1rem" }}>Claim Reward</button>
                        <p style={{ marginTop: "1rem" }}>
                          <strong>Pending Reward:</strong> {pendingReward} NERDIE
                        </p>
                        <p style={{ marginTop: "0.5rem" }}>
                          <strong>Staked NFTs:</strong> {stakedCount}
                        </p>
                      </div>
                      {/* Manage Funds Section */}
                      <div style={{ marginTop: "1rem", padding: "1rem", borderTop: "1px solid #ccc" }}>
                        <h4>Manage Funds</h4>
                        <div>
                          <label>
                            Recipient:{" "}
                            <input type="text" value={sendRecipient} onChange={(e) => setSendRecipient(e.target.value)} placeholder="0x..." />
                          </label>
                        </div>
                        <div>
                          <label>
                            Amount:{" "}
                            <input type="text" value={sendAmount} onChange={(e) => setSendAmount(e.target.value)} placeholder="e.g., 0.1" />
                          </label>
                        </div>
                        <div>
                          <label>
                            Asset:{" "}
                            <select value={selectedSendToken} onChange={(e) => setSelectedSendToken(e.target.value)}>
                              <option value="ETH">ETH</option>
                              {tokenAccounts[selectedNFT.tokenId].erc20 &&
                                tokenAccounts[selectedNFT.tokenId].erc20.map((token, index) => {
                                  const meta = tokenMetadata[token.contractAddress];
                                  const displayName = meta ? `${meta.name} (${meta.symbol})` : token.contractAddress;
                                  return <option key={index} value={token.contractAddress}>{displayName}</option>;
                                })}
                            </select>
                          </label>
                        </div>
                        <button onClick={() => sendFundsFromTBA(selectedNFT.tokenId, sendRecipient, sendAmount)}>
                          Send Funds
                        </button>
                        <button onClick={() => withdrawFundsToOwner(selectedNFT.tokenId)} style={{ marginLeft: "1rem" }}>
                          Withdraw to NFT Owner
                        </button>
                      </div>
                      {/* Moving Average Bot Section */}
                      <div style={{ marginTop: "2rem", padding: "1rem", borderTop: "1px solid #ccc" }}>
                        <h4>Moving Average, FMA, SMA & RSI Bot</h4>
                        <p>Enter up to 5 CoinGecko coin IDs (e.g., "bitcoin", "ethereum") to monitor:</p>
                        {Array.from({ length: 5 }).map((_, idx) => (
                          <div key={idx} style={{ marginBottom: "0.5rem" }}>
                            <input
                              type="text"
                              value={botAddresses[idx] || ""}
                              onChange={(e) => updateBotAddress(idx, e.target.value)}
                              placeholder={`Coin ID ${idx + 1}`}
                              style={{ width: "100%" }}
                            />
                          </div>
                        ))}
                        <div style={{ marginTop: "0.5rem" }}>
                          <label>SMA Period (Slow MA):{" "}
                            <input type="number" value={smaPeriodInput} onChange={(e) => setSmaPeriodInput(Number(e.target.value))} />
                          </label>
                        </div>
                        <div style={{ marginTop: "0.5rem" }}>
                          <label>FMA Period (Fast MA):{" "}
                            <input type="number" value={fmaPeriodInput} onChange={(e) => setFmaPeriodInput(Number(e.target.value))} />
                          </label>
                        </div>
                        <div style={{ marginTop: "0.5rem" }}>
                          <label>RSI Period:{" "}
                            <input type="number" value={rsiPeriodInput} onChange={(e) => setRsiPeriodInput(Number(e.target.value))} />
                          </label>
                        </div>
                        <div style={{ marginTop: "0.5rem" }}>
                          {botRunning ? (
                            <button onClick={stopMovingAverageBot}>Stop Bot</button>
                          ) : (
                            <button onClick={startMovingAverageBot}>Start Bot</button>
                          )}
                        </div>
                        <div style={{ marginTop: "1rem" }}>
                          <h5>Bot Signals:</h5>
                          {Object.keys(botSignals).length > 0 ? (
                            Object.entries(botSignals).map(([coinId, signal]) => (
                              <p key={coinId}><strong>{coinId}:</strong> {signal}</p>
                            ))
                          ) : (
                            <p>No signals yet.</p>
                          )}
                        </div>
                      </div>
                    </>
                  ) : (
                    <p>Loading NFT details...</p>
                  )}
                </div>
              ) : (
                <p>Please select an NFT to see details.</p>
              )}
            </div>
          </div>
        </>
      )}
      {status && (
        <p style={{ marginTop: "2rem", color: "blue" }}>
          <strong>Status:</strong> {status}
        </p>
      )}
    </div>
  );
}

export default App;
