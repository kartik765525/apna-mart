bash -lc cat > /mnt/data/apnamart_fixed/server.js <<'EOF'
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 5000;

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'apna_mart_admin_secret_2026';
const CUSTOMER_JWT_SECRET = process.env.CUSTOMER_JWT_SECRET || 'apna_mart_customer_secret_2026';
const DELIVERY_JWT_SECRET = process.env.DELIVERY_JWT_SECRET || 'apna_mart_delivery_secret_2026';

const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || 'kartikey parihar').trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '7518576269').trim();
const OTP_EXPIRY_MS = 5 * 60 * 1000;

const appDir = __dirname;
const publicDir = path.join(appDir, 'public');
const dataDir = path.join(appDir, 'data');
const uploadsDir = path.join(appDir, 'uploads');
const productsFile = path.join(dataDir, 'products.json');
const ordersFile = path.join(dataDir, 'orders.json');
const deliveryUsersFile = path.join(dataDir, 'delivery-users.json');

const otpStore = new Map();

const ALLOWED_VILLAGES = {
  bihar: 5,
  'narayan nagla': 7,
  bankati: 10,
  gadi: 11,
  kattina: 15,
  kudiyani: 10,
  rupnagar: 15,
  pakadiya: 15,
  tiliyani: 15
};

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function ensureFile(filePath, defaultValue = '[]') {
  ensureDir(path.dirname(filePath));
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, defaultValue, 'utf8');
}

function readJson(filePath, fallback = []) {
  try {
    ensureFile(filePath);
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    console.error('JSON read error:', filePath, error.message);
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureFile(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

ensureDir(publicDir);
ensureDir(dataDir);
ensureDir(uploadsDir);
ensureFile(productsFile);
ensureFile(ordersFile);
ensureFile(deliveryUsersFile);

app.use('/uploads', express.static(uploadsDir));
app.use(express.static(publicDir));

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').trim();
}

function normalizeVillage(village) {
  return String(village || '').trim().toLowerCase();
}

function getVillageDeliveryCharge(village) {
  const key = normalizeVillage(village);
  return Object.prototype.hasOwnProperty.call(ALLOWED_VILLAGES, key) ? Number(ALLOWED_VILLAGES[key]) : null;
}

function getISTDateTime() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
}

function getNowISO() {
  return new Date().toISOString();
}

function generateOrderId() {
  return 'ORD' + Date.now();
}

function generateDeliveryId() {
  return 'DB' + Date.now();
}

function sanitizeLocation(location) {
  if (!location || typeof location !== 'object') return null;
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  const accuracy = Number(location.accuracy || 0);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    latitude,
    longitude,
    accuracy: Number.isFinite(accuracy) ? accuracy : 0,
    updatedAt: getISTDateTime(),
    live: true
  };
}

function clearLiveLocation() {
  return { latitude: '', longitude: '', accuracy: 0, updatedAt: '', live: false };
}

function isOrderLiveTrackable(order) {
  const status = String(order?.status || '').trim().toLowerCase();
  return !['delivered', 'cancelled', 'canceled'].includes(status);
}

function normalizeOrderForResponse(order) {
  return { ...order, customerLocation: order.customerLocation || clearLiveLocation() };
}

function deleteImageByUrl(imageUrl) {
  try {
    if (!imageUrl || typeof imageUrl !== 'string') return;
    const cleanedUrl = imageUrl.split('?')[0];
    if (!cleanedUrl.includes('/uploads/')) return;
    const fileName = path.basename(cleanedUrl);
    const filePath = path.join(uploadsDir, fileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    console.error('Image delete error:', error.message);
  }
}

let serviceAccount = null;
let db = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else if (fs.existsSync(path.join(appDir, 'firebase-service-account.json'))) {
    serviceAccount = require(path.join(appDir, 'firebase-service-account.json'));
  }
  if (serviceAccount && !admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
  }
} catch (error) {
  console.error('Firebase init failed, falling back to local JSON:', error.message);
  db = null;
}

async function readProducts() {
  if (db) {
    try {
      const snapshot = await db.collection('products').get();
      return snapshot.docs.map((doc) => ({ ...doc.data(), id: Number(doc.data().id ?? doc.id) }));
    } catch (error) {
      console.error('Firestore readProducts error:', error.message);
    }
  }
  return readJson(productsFile, []);
}

async function writeProducts(products) {
  writeJson(productsFile, products);
  if (db) {
    try {
      const batch = db.batch();
      const ref = db.collection('products');
      const current = await ref.get();
      current.docs.forEach((doc) => batch.delete(doc.ref));
      products.forEach((product) => batch.set(ref.doc(String(product.id)), product));
      await batch.commit();
    } catch (error) {
      console.error('Firestore writeProducts error:', error.message);
    }
  }
}

async function readOrders() {
  if (db) {
    try {
      const snapshot = await db.collection('orders').get();
      return snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.data().id || doc.id }));
    } catch (error) {
      console.error('Firestore readOrders error:', error.message);
    }
  }
  return readJson(ordersFile, []);
}

async function writeOrders(orders) {
  writeJson(ordersFile, orders);
  if (db) {
    try {
      const batch = db.batch();
      const ref = db.collection('orders');
      const current = await ref.get();
      current.docs.forEach((doc) => batch.delete(doc.ref));
      orders.forEach((order) => batch.set(ref.doc(String(order.id)), order));
      await batch.commit();
    } catch (error) {
      console.error('Firestore writeOrders error:', error.message);
    }
  }
}

function createAdminToken() {
  return jwt.sign({ username: ADMIN_USERNAME, role: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: '7d' });
}
function createCustomerToken(phone, village) {
  return jwt.sign({ phone, village, role: 'customer' }, CUSTOMER_JWT_SECRET, { expiresIn: '30d' });
}
function createDeliveryToken(deliveryUser) {
  return jwt.sign({ id: deliveryUser.id, name: deliveryUser.name, phone: deliveryUser.phone, role: 'delivery' }, DELIVERY_JWT_SECRET, { expiresIn: '30d' });
}

function authFromHeader(req) {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
}

function requireAdmin(req, res, next) {
  const token = authFromHeader(req);
  if (!token) return res.status(401).json({ message: 'Admin login required' });
  try {
    req.admin = jwt.verify(token, ADMIN_JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired admin token' });
  }
}
function requireCustomer(req, res, next) {
  const token = authFromHeader(req);
  if (!token) return res.status(401).json({ message: 'Customer login required' });
  try {
    req.customer = jwt.verify(token, CUSTOMER_JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired customer token' });
  }
}
function requireDelivery(req, res, next) {
  const token = authFromHeader(req);
  if (!token) return res.status(401).json({ message: 'Delivery login required' });
  try {
    req.delivery = jwt.verify(token, DELIVERY_JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired delivery token' });
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    const base = path.basename(file.originalname || 'image', ext).replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 40) || 'image';
    cb(null, `${Date.now()}-${base}${ext}`);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));
app.get('/delivery', (req, res) => res.sendFile(path.join(publicDir, 'delivery.html')));

app.post('/api/customer/request-otp', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone || phone.length < 10) return res.status(400).json({ message: 'Valid mobile number required' });
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(phone, { otp, expiresAt: Date.now() + OTP_EXPIRY_MS });
  res.json({ message: 'OTP sent successfully', demoOtp: otp, expiresInSeconds: 300 });
});

app.post('/api/customer/verify-otp', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const otp = String(req.body.otp || '').trim();
  const village = normalizeVillage(req.body.village);
  const saved = otpStore.get(phone);
  if (!saved) return res.status(400).json({ message: 'OTP not requested' });
  if (Date.now() > saved.expiresAt) {
    otpStore.delete(phone);
    return res.status(400).json({ message: 'OTP expired' });
  }
  if (saved.otp !== otp) return res.status(400).json({ message: 'Invalid OTP' });
  const deliveryCharge = getVillageDeliveryCharge(village);
  if (deliveryCharge === null) return res.status(400).json({ message: 'Currently not available this address' });
  otpStore.delete(phone);
  const token = createCustomerToken(phone, village);
  res.json({ message: 'Customer login successful', token, customer: { phone, village, deliveryCharge } });
});

app.get('/api/customer/me', requireCustomer, (req, res) => {
  res.json({ customer: { phone: req.customer.phone, village: req.customer.village || '' } });
});

app.patch('/api/customer/location', requireCustomer, async (req, res) => {
  const phone = normalizePhone(req.customer.phone);
  const nextLocation = sanitizeLocation(req.body);
  if (!nextLocation) return res.status(400).json({ message: 'Valid customer location required' });
  const orders = await readOrders();
  let updatedCount = 0;
  for (const order of orders) {
    if (normalizePhone(order.phone) !== phone) continue;
    if (!isOrderLiveTrackable(order)) continue;
    order.customerLocation = { ...nextLocation };
    updatedCount += 1;
  }
  await writeOrders(orders);
  res.json({ message: 'Customer live location updated', updatedCount });
});

app.post('/api/admin/login', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '').trim();
  if (username !== ADMIN_USERNAME.toLowerCase() || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ message: 'Invalid username or password' });
  }
  res.json({ message: 'Login successful', token: createAdminToken(), admin: { username: ADMIN_USERNAME } });
});
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ admin: { username: ADMIN_USERNAME } }));

app.post('/api/delivery/request-access', (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = normalizePhone(req.body.phone);
  if (!name || !phone || phone.length < 10) return res.status(400).json({ message: 'Valid name and phone required' });
  const deliveryUsers = readJson(deliveryUsersFile, []);
  const existing = deliveryUsers.find((user) => normalizePhone(user.phone) === phone);
  if (existing) {
    if (existing.status === 'Approved') return res.status(400).json({ message: 'This number is already approved. Please login.' });
    if (existing.status === 'Pending Approval') return res.status(400).json({ message: 'Your approval request is already pending.' });
    return res.status(400).json({ message: 'This number already exists. Contact admin.' });
  }
  const newUser = {
    id: generateDeliveryId(),
    name,
    phone,
    status: 'Pending Approval',
    deviceId: '',
    createdAt: getISTDateTime(),
    approvedAt: '',
    updatedAt: getISTDateTime(),
    lastLoginAt: ''
  };
  deliveryUsers.unshift(newUser);
  writeJson(deliveryUsersFile, deliveryUsers);
  res.status(201).json({ message: 'Request sent to admin for approval', deliveryUser: newUser });
});

app.post('/api/delivery/login', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const deviceId = String(req.body.deviceId || '').trim();
  if (!phone || phone.length < 10) return res.status(400).json({ message: 'Valid phone required' });
  if (!deviceId) return res.status(400).json({ message: 'Device not recognized. Please reopen panel.' });
  const deliveryUsers = readJson(deliveryUsersFile, []);
  const index = deliveryUsers.findIndex((user) => normalizePhone(user.phone) === phone);
  if (index === -1) return res.status(404).json({ message: 'No delivery ID found for this number. First request approval.' });
  const deliveryUser = deliveryUsers[index];
  if (deliveryUser.status === 'Pending Approval') return res.status(403).json({ message: 'Your ID is waiting for admin approval.' });
  if (deliveryUser.status !== 'Approved') return res.status(403).json({ message: 'This delivery ID is not active.' });
  if (deliveryUser.deviceId && deliveryUser.deviceId !== deviceId) return res.status(403).json({ message: 'This ID is already active on another device. Contact admin.' });
  if (!deliveryUser.deviceId) deliveryUsers[index].deviceId = deviceId;
  deliveryUsers[index].lastLoginAt = getISTDateTime();
  deliveryUsers[index].updatedAt = getISTDateTime();
  writeJson(deliveryUsersFile, deliveryUsers);
  const approvedUser = deliveryUsers[index];
  res.json({ message: 'Delivery login successful', token: createDeliveryToken(approvedUser), delivery: { id: approvedUser.id, name: approvedUser.name, phone: approvedUser.phone } });
});

app.get('/api/delivery/me', requireDelivery, (req, res) => {
  const deliveryUsers = readJson(deliveryUsersFile, []);
  const deliveryUser = deliveryUsers.find((user) => String(user.id) === String(req.delivery.id));
  if (!deliveryUser || deliveryUser.status !== 'Approved') return res.status(401).json({ message: 'Delivery ID not active' });
  res.json({ delivery: { id: deliveryUser.id, name: deliveryUser.name, phone: deliveryUser.phone, status: deliveryUser.status } });
});

app.get('/api/admin/delivery-users', requireAdmin, (req, res) => {
  res.json(readJson(deliveryUsersFile, []));
});

app.patch('/api/admin/delivery-users/:id', requireAdmin, (req, res) => {
  const deliveryUsers = readJson(deliveryUsersFile, []);
  const userId = String(req.params.id);
  const index = deliveryUsers.findIndex((user) => String(user.id) === userId);
  if (index === -1) return res.status(404).json({ message: 'Delivery ID not found' });

  const { action, name, phone, resetDevice } = req.body;
  if (name !== undefined) {
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ message: 'Valid name required' });
    deliveryUsers[index].name = cleanName;
  }
  if (phone !== undefined) {
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone || cleanPhone.length < 10) return res.status(400).json({ message: 'Valid phone required' });
    const duplicate = deliveryUsers.find((user, i) => i !== index && normalizePhone(user.phone) === cleanPhone);
    if (duplicate) return res.status(400).json({ message: 'This phone already exists' });
    deliveryUsers[index].phone = cleanPhone;
  }
  if (action === 'approve') {
    deliveryUsers[index].status = 'Approved';
    deliveryUsers[index].approvedAt = getISTDateTime();
  } else if (action === 'reject') {
    deliveryUsers[index].status = 'Rejected';
    deliveryUsers[index].deviceId = '';
  } else if (action === 'pending') {
    deliveryUsers[index].status = 'Pending Approval';
    deliveryUsers[index].deviceId = '';
  }
  if (resetDevice) deliveryUsers[index].deviceId = '';
  deliveryUsers[index].updatedAt = getISTDateTime();
  writeJson(deliveryUsersFile, deliveryUsers);
  res.json({ message: 'Delivery ID updated successfully', deliveryUser: deliveryUsers[index] });
});

app.delete('/api/admin/delivery-users/:id', requireAdmin, (req, res) => {
  const deliveryUsers = readJson(deliveryUsersFile, []);
  const userId = String(req.params.id);
  const filtered = deliveryUsers.filter((user) => String(user.id) !== userId);
  if (filtered.length === deliveryUsers.length) return res.status(404).json({ message: 'Delivery ID not found' });
  writeJson(deliveryUsersFile, filtered);
  res.json({ message: 'Delivery ID deleted successfully' });
});

app.post('/upload', requireAdmin, (req, res) => {
  upload.single('image')(req, res, (error) => {
    if (error) return res.status(400).json({ message: error.message || 'Image upload failed' });
    if (!req.file) return res.status(400).json({ message: 'No image file uploaded' });
    res.status(201).json({ message: 'Image uploaded successfully', imageUrl: `/uploads/${req.file.filename}` });
  });
});

app.get('/api/products', async (req, res) => {
  const products = await readProducts();
  res.json(Array.isArray(products) ? products : []);
});

app.post('/api/products', requireAdmin, async (req, res) => {
  const products = await readProducts();
  const { name, price, original, image, category, stock, active } = req.body;
  if (!name || !price) return res.status(400).json({ message: 'Product name and price are required' });
  const numericPrice = Number(price);
  const numericOriginal = Number(original || price);
  const numericStock = Number(stock || 0);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) return res.status(400).json({ message: 'Valid product price is required' });
  const product = {
    id: Date.now(),
    name: String(name).trim(),
    price: numericPrice,
    original: Number.isFinite(numericOriginal) ? numericOriginal : numericPrice,
    image: typeof image === 'string' ? image.trim() : '',
    category: String(category || 'Grocery').trim() || 'Grocery',
    stock: Number.isFinite(numericStock) ? numericStock : 0,
    active: active !== undefined ? Boolean(active) : numericStock > 0
  };
  products.push(product);
  await writeProducts(products);
  res.status(201).json({ message: 'Product added successfully', product });
});

app.put('/api/products/:id', requireAdmin, async (req, res) => {
  const products = await readProducts();
  const productId = Number(req.params.id);
  const index = products.findIndex((p) => Number(p.id) === productId);
  if (index === -1) return res.status(404).json({ message: 'Product not found' });
  const oldProduct = products[index];
  const updated = { ...oldProduct, ...req.body, id: oldProduct.id };
  updated.name = String(updated.name || '').trim();
  updated.category = String(updated.category || 'Grocery').trim() || 'Grocery';
  updated.price = Number(updated.price);
  updated.original = Number(updated.original || updated.price);
  updated.stock = Number(updated.stock ?? 0);
  updated.image = typeof updated.image === 'string' ? updated.image.trim() : oldProduct.image || '';
  if (!updated.name) return res.status(400).json({ message: 'Product name is required' });
  if (!Number.isFinite(updated.price) || updated.price <= 0) return res.status(400).json({ message: 'Valid product price is required' });
  if (!Number.isFinite(updated.stock) || updated.stock < 0) return res.status(400).json({ message: 'Valid product stock is required' });
  if (oldProduct.image && updated.image !== oldProduct.image && updated.image) deleteImageByUrl(oldProduct.image);
  products[index] = updated;
  await writeProducts(products);
  res.json({ message: 'Product updated successfully', product: updated });
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  const products = await readProducts();
  const productId = Number(req.params.id);
  const product = products.find((p) => Number(p.id) === productId);
  if (!product) return res.status(404).json({ message: 'Product not found' });
  if (product.image) deleteImageByUrl(product.image);
  await writeProducts(products.filter((p) => Number(p.id) !== productId));
  res.json({ message: 'Product deleted successfully' });
});

app.post('/api/orders', requireCustomer, async (req, res) => {
  const phone = normalizePhone(req.customer.phone);
  const village = normalizeVillage(req.customer.village);
  const { name, address, paymentMethod, items, customerLocation } = req.body;
  if (!String(name || '').trim()) return res.status(400).json({ message: 'Customer name required' });
  if (!String(address || '').trim()) return res.status(400).json({ message: 'Delivery address required' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: 'Order items required' });
  const products = await readProducts();
  const orders = await readOrders();
  const finalItems = [];
  let subtotal = 0;
  for (const item of items) {
    const productId = String(item.id || '').trim();
    const qty = Number(item.qty || 0);
    if (!productId || !Number.isFinite(qty) || qty <= 0) return res.status(400).json({ message: 'Invalid item data' });
    const productIndex = products.findIndex((p) => String(p.id) === productId);
    if (productIndex === -1) return res.status(404).json({ message: 'One or more products not found' });
    const product = products[productIndex];
    const stock = Number(product.stock || 0);
    if (qty > stock) return res.status(400).json({ message: `${product.name || 'Product'} is out of stock or insufficient quantity` });
    const price = Number(product.price || 0);
    const originalPrice = Number(product.original || price || 0);
    finalItems.push({ id: product.id, name: product.name || '', price, originalPrice, qty, image: product.image || '', category: product.category || '' });
    subtotal += price * qty;
  }
  const shipping = Number(getVillageDeliveryCharge(village) || 0);
  const total = subtotal + shipping;
  const cleanPaymentMethod = String(paymentMethod || 'cod').trim().toLowerCase() === 'upi' ? 'UPI' : 'COD';
  const cleanCustomerLocation = sanitizeLocation(customerLocation);
  const newOrder = {
    id: generateOrderId(),
    name: String(name).trim(),
    phone,
    village,
    address: String(address).trim(),
    paymentMethod: cleanPaymentMethod,
    paymentStatus: cleanPaymentMethod === 'UPI' ? 'Payment Pending' : 'COD',
    items: finalItems,
    subtotal,
    shipping,
    total,
    status: 'Need Confirmation',
    assignedDeliveryBoyId: '',
    assignedDeliveryBoyName: '',
    assignedDeliveryBoyPhone: '',
    deliveryBoyId: '',
    deliveryBoyName: '',
    deliveryBoyPhone: '',
    deliveryStartedAt: '',
    deliveredAt: '',
    customerLocation: cleanCustomerLocation || clearLiveLocation(),
    date: getISTDateTime(),
    createdAtISO: getNowISO()
  };
  for (const item of finalItems) {
    const idx = products.findIndex((p) => String(p.id) === String(item.id));
    if (idx !== -1) products[idx].stock = Math.max(0, Number(products[idx].stock || 0) - Number(item.qty || 0));
  }
  orders.unshift(newOrder);
  await writeProducts(products);
  await writeOrders(orders);
  res.status(201).json({ message: 'Order placed successfully', order: normalizeOrderForResponse(newOrder) });
});

app.get('/api/my-orders', requireCustomer, async (req, res) => {
  const phone = normalizePhone(req.customer.phone);
  const orders = await readOrders();
  const customerOrders = orders.filter((order) => normalizePhone(order.phone) === phone).map(normalizeOrderForResponse);
  res.json(customerOrders);
});

app.get('/api/orders', requireAdmin, async (req, res) => {
  const orders = (await readOrders()).map(normalizeOrderForResponse);
  res.json(orders);
});
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const orders = (await readOrders()).map(normalizeOrderForResponse);
  res.json(orders);
});

app.patch('/api/admin/orders/:id/status', requireAdmin, async (req, res) => {
  const orders = await readOrders();
  const orderId = String(req.params.id || '').trim();
  const { status, paymentStatus } = req.body;
  const index = orders.findIndex((o) => String(o.id) === orderId);
  if (index === -1) return res.status(404).json({ message: 'Order not found' });
  if (status) {
    const validStatuses = ['Need Confirmation', 'Pending', 'Out for Delivery', 'Delivered'];
    if (!validStatuses.includes(status)) return res.status(400).json({ message: 'Invalid status' });
    orders[index].status = status;
    if (status === 'Delivered') {
      orders[index].deliveredAt = getISTDateTime();
      orders[index].customerLocation = clearLiveLocation();
    }
  }
  if (paymentStatus) {
    const validPaymentStatuses = ['COD', 'Payment Pending', 'Payment Confirmed'];
    if (!validPaymentStatuses.includes(paymentStatus)) return res.status(400).json({ message: 'Invalid payment status' });
    orders[index].paymentStatus = paymentStatus;
  }
  await writeOrders(orders);
  res.json({ message: 'Order updated successfully', order: normalizeOrderForResponse(orders[index]) });
});

app.patch('/api/admin/orders/:id/assign-delivery', requireAdmin, async (req, res) => {
  const orders = await readOrders();
  const deliveryUsers = readJson(deliveryUsersFile, []);
  const orderId = String(req.params.id || '').trim();
  const deliveryBoyId = String(req.body.deliveryBoyId || '').trim();
  if (!deliveryBoyId) return res.status(400).json({ message: 'Delivery boy ID required' });
  const orderIndex = orders.findIndex((o) => String(o.id || '').trim() === orderId);
  if (orderIndex === -1) return res.status(404).json({ message: 'Order not found' });
  const deliveryBoy = deliveryUsers.find((d) => String(d.id || '').trim() === deliveryBoyId);
  if (!deliveryBoy) return res.status(400).json({ message: 'Delivery boy ID not found' });
  if (String(deliveryBoy.status || '').trim().toLowerCase() !== 'approved') {
    return res.status(400).json({ message: `Delivery boy not approved. Current status: ${deliveryBoy.status || 'Unknown'}` });
  }
  orders[orderIndex].assignedDeliveryBoyId = deliveryBoy.id;
  orders[orderIndex].assignedDeliveryBoyName = deliveryBoy.name;
  orders[orderIndex].assignedDeliveryBoyPhone = deliveryBoy.phone;
  orders[orderIndex].deliveryBoyId = deliveryBoy.id;
  orders[orderIndex].deliveryBoyName = deliveryBoy.name;
  orders[orderIndex].deliveryBoyPhone = deliveryBoy.phone;
  await writeOrders(orders);
  res.json({ message: 'Delivery boy assigned successfully', order: normalizeOrderForResponse(orders[orderIndex]) });
});

app.get('/api/delivery/orders', requireDelivery, async (req, res) => {
  const orders = await readOrders();
  const deliveryOrders = orders.filter((order) => String(order.assignedDeliveryBoyId || order.deliveryBoyId || '').trim() === String(req.delivery.id || '').trim()).map(normalizeOrderForResponse);
  res.json(deliveryOrders);
});

async function handleDeliveryStatusUpdate(req, res) {
  const orderId = String(req.params.id || '').trim();
  const status = String(req.body.status || '').trim();
  const allowedStatuses = ['Pending', 'Out for Delivery', 'Delivered'];
  if (!allowedStatuses.includes(status)) return res.status(400).json({ message: 'Invalid order status' });
  const orders = await readOrders();
  const index = orders.findIndex((order) => String(order.id) === orderId);
  if (index === -1) return res.status(404).json({ message: 'Order not found' });
  const assignedId = String(orders[index].assignedDeliveryBoyId || orders[index].deliveryBoyId || '').trim();
  if (assignedId !== String(req.delivery.id || '').trim()) return res.status(403).json({ message: 'This order is not assigned to you' });
  orders[index].status = status;
  orders[index].deliveryBoyId = req.delivery.id || orders[index].deliveryBoyId || '';
  orders[index].deliveryBoyName = req.delivery.name || orders[index].deliveryBoyName || '';
  orders[index].deliveryBoyPhone = req.delivery.phone || orders[index].deliveryBoyPhone || '';
  if (status === 'Out for Delivery') {
    orders[index].deliveryStartedAt = getISTDateTime();
    if (orders[index].customerLocation && orders[index].customerLocation.latitude !== '') {
      orders[index].customerLocation.live = true;
      orders[index].customerLocation.updatedAt = getISTDateTime();
    }
  }
  if (status === 'Delivered') {
    orders[index].deliveredAt = getISTDateTime();
    orders[index].customerLocation = clearLiveLocation();
  }
  await writeOrders(orders);
  res.json({ message: 'Order status updated successfully', order: normalizeOrderForResponse(orders[index]) });
}
app.patch('/api/delivery/orders/:id/status', requireDelivery, handleDeliveryStatusUpdate);
app.put('/api/delivery/orders/:id/status', requireDelivery, handleDeliveryStatusUpdate);

app.put('/api/orders/:id/payment-status', requireAdmin, async (req, res) => {
  const orders = await readOrders();
  const orderId = String(req.params.id || '').trim();
  const { paymentStatus } = req.body;
  const validPaymentStatuses = ['COD', 'Payment Pending', 'Payment Confirmed'];
  const index = orders.findIndex((o) => String(o.id) === orderId);
  if (index === -1) return res.status(404).json({ message: 'Order not found' });
  if (!paymentStatus || !validPaymentStatuses.includes(paymentStatus)) return res.status(400).json({ message: 'Invalid payment status' });
  orders[index].paymentStatus = paymentStatus;
  await writeOrders(orders);
  res.json({ message: 'Payment status updated successfully', order: normalizeOrderForResponse(orders[index]) });
});

app.delete('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const orders = await readOrders();
  const orderId = String(req.params.id || '').trim();
  const filteredOrders = orders.filter((o) => String(o.id) !== orderId);
  if (filteredOrders.length === orders.length) return res.status(404).json({ message: 'Order not found' });
  await writeOrders(filteredOrders);
  res.json({ message: 'Order deleted successfully' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Mode: ${db ? 'Firestore + JSON backup' : 'Local JSON fallback'}`);
});
EOF
