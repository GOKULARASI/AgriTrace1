const express = require('express');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const Product = require('../models/Product');
const Transaction = require('../models/Transaction');
const jwt = require('jsonwebtoken');

// Middleware to verify JWT and check role
const auth = (roles = []) => {
    return (req, res, next) => {
        const token = req.header('x-auth-token');
        if (!token) return res.status(401).json({ msg: 'No token, authorization denied' });

        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'supersecretagritrace123');
            req.user = decoded.user;
            
            if (roles.length && !roles.includes(req.user.role)) {
                return res.status(401).json({ msg: 'Unauthorized role' });
            }
            next();
        } catch (err) {
            res.status(401).json({ msg: 'Token is not valid' });
        }
    };
};

const getContract = () => {
    try {
        const contractPath = path.join(__dirname, '../config/contractAddress.json');
        const artifactPath = path.join(__dirname, '../config/SupplyChain.json');
        
        if (!fs.existsSync(contractPath) || !fs.existsSync(artifactPath)) {
            console.error("Contract config files missing.");
            return null;
        }

        const { address } = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
        const { abi } = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

        const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545'); // Hardhat node
        // In a real app, you'd use a specific wallet. Here we use the first Hardhat account for demo.
        const wallet = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider); 
        const contract = new ethers.Contract(address, abi, wallet);
        
        return contract;
    } catch (e) {
        console.error("Error init contract:", e);
        return null;
    }
};

// 1. Farmer adds product
router.post('/add', auth(['Farmer', 'Admin']), async (req, res) => {
    try {
        const { productId, cropName, quantityText, farmerLocation } = req.body;

        let product = new Product({
            productId,
            cropName,
            quantityText,
            farmerLocation,
            currentStatus: 'Created'
        });

        await product.save();

        const contract = getContract();
        if (contract) {
            try {
                // Call addFarmerDetails on contract
                const tx = await contract.addFarmerDetails(
                    cropName,
                    new Date().toISOString(), // sowingDate (simplification for demo)
                    new Date().toISOString(), // harvestDate (simplification for demo)
                    farmerLocation,
                    quantityText,
                    "N/A" // farmerPrice
                );
                await tx.wait(); // Wait for confirmation
                console.log("Transaction confirmed on blockchain:", tx.hash);
            } catch (e) {
                console.error("Failed to write to blockchain:", e);
            }
        }

        res.json(product);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// 2. Industry processes product
router.post('/process/:productId', auth(['Industry', 'Admin']), async (req, res) => {
    try {
        const { batchId } = req.body;
        let product = await Product.findOne({ productId: req.params.productId });
        
        if (!product) return res.status(404).json({ msg: 'Product not found' });
        if (product.currentStatus !== 'Created') return res.status(400).json({ msg: 'Invalid state transition' });

        product.batchId = batchId;
        product.currentStatus = 'Processed';
        
        // Generate QR code link roughly simulating tracking
        product.qrCodeUrl = `http://localhost:5173/trace/${batchId}`;

        await product.save();

        const contract = getContract();
        if (contract) {
            try {
                const tx = await contract.addIndustryDetails(
                    product.productId,
                    batchId,
                    product.cropName + " Processed",
                    new Date().toISOString()
                );
                await tx.wait();
                console.log("Industry tx confirmed:", tx.hash);
            } catch (e) {
                console.error("Blockchain error:", e);
            }
        }

        res.json(product);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// 3. Transport ships product
router.post('/ship/:productId', auth(['Transport', 'Admin']), async (req, res) => {
    try {
        let product = await Product.findOne({ productId: req.params.productId });
        
        if (!product) return res.status(404).json({ msg: 'Product not found' });
        if (product.currentStatus !== 'Processed') return res.status(400).json({ msg: 'Invalid state transition' });

        product.currentStatus = 'Shipped';
        await product.save();

        const contract = getContract();
        if (contract) {
            try {
                const tx = await contract.addTransportDetails(
                    product.productId,
                    "TRANSPORT-01",
                    new Date().toISOString(),
                    new Date(Date.now() + 86400000).toISOString(), // +1 day
                    "Dry"
                );
                await tx.wait();
                console.log("Transport tx confirmed:", tx.hash);
            } catch (e) {
                console.error("Blockchain error:", e);
            }
        }

        res.json(product);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// 4. Retail receives product
router.post('/receive/:productId', auth(['Retail', 'Admin']), async (req, res) => {
    try {
        let product = await Product.findOne({ productId: req.params.productId });
        
        if (!product) return res.status(404).json({ msg: 'Product not found' });
        if (product.currentStatus !== 'Shipped') return res.status(400).json({ msg: 'Invalid state transition' });

        product.currentStatus = 'Received';
        await product.save();

        const contract = getContract();
        if (contract) {
            try {
                const tx = await contract.addRetailDetails(
                    product.productId,
                    "Retail Store 1",
                    "City Center",
                    "N/A"
                );
                await tx.wait();
                console.log("Retail tx confirmed:", tx.hash);
            } catch (e) {
                console.error("Blockchain error:", e);
            }
        }

        res.json(product);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// 5. Get all products
router.get('/', async (req, res) => {
    try {
        const products = await Product.find().sort({ date: -1 });
        res.json(products);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// 6. Get product by batch id (For consumer)
router.get('/trace/:batchId', async (req, res) => {
    try {
        const product = await Product.findOne({ batchId: req.params.batchId });
        if (!product) return res.status(404).json({ msg: 'Product not found' });
        
        let onChainData = null;
        const contract = getContract();
        if (contract) {
            try {
                // Return data directly from contract instead of backend db for demo proof
                onChainData = await contract.getProductByBatchId(req.params.batchId);
                // Convert BigInts and structure for frontend
                onChainData = {
                    farmer: onChainData.farmer,
                    cropName: onChainData.cropName,
                    harvestDate: onChainData.harvestDate,
                    industry: onChainData.industry,
                    processingDate: onChainData.processingDate,
                    transporter: onChainData.transporter,
                    shipmentDate: onChainData.shipmentDate,
                    retailer: onChainData.retailer,
                    storeName: onChainData.storeName
                }
            } catch (e) {
                console.error("Blockchain read error:", e);
            }
        }

        res.json({ product, onChainData });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

// 7. Add Transaction (Payment/Purchase) with Duplicate Prevention
router.post('/transaction/add', auth(['Farmer', 'Industry', 'Admin']), async (req, res) => {
    try {
        const { transactionId, amount, type, paymentMethod } = req.body;
        let { farmerId, industryId, productId } = req.body;

        // Auto-populate IDs from user context if missing
        if (!farmerId && req.user.role === 'Farmer') {
            farmerId = req.user.id;
        }
        if (!industryId && req.user.role === 'Industry') {
            industryId = req.user.id;
        }

        // 1. Exact Transaction ID check
        const existingTransaction = await Transaction.findOne({ transactionId });
        if (existingTransaction) {
            return res.status(400).json({ msg: 'Duplicate transaction detected. This Transaction ID already exists.' });
        }

        // 2. Fuzzy Duplicate check (same user, product, and amount within last 5 minutes)
        // This prevents accidental double-clicks or re-submissions of the same payment.
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const fuzzyDuplicate = await Transaction.findOne({
            $or: [
                { farmerId: farmerId || null },
                { industryId: industryId || null }
            ].filter(q => q.farmerId !== null || q.industryId !== null),
            productId,
            amount,
            date: { $gte: fiveMinutesAgo }
        });

        if (fuzzyDuplicate) {
            return res.status(400).json({ msg: 'A similar transaction was recently recorded. Please wait a few minutes before trying again or use a unique Transaction ID.' });
        }

        const transaction = new Transaction({
            transactionId,
            farmerId,
            industryId,
            productId,
            amount,
            type,
            paymentMethod
        });

        await transaction.save();
        res.json({ msg: 'Transaction recorded successfully', transaction });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server error');
    }
});

module.exports = router;
