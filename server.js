const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

/* =========================
   TOKENS / LOGIN SETTINGS
   ========================= */
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'apna_mart_admin_secret_2026';
const CUSTOMER_JWT_SECRET = process.env.CUSTOMER_JWT_SECRET || 'apna_mart_customer_secret_2026';
const DELIVERY_JWT_SECRET = process.env.DELIVERY_JWT_SECRET || 'apna_mart_delivery_secret_2026';

/* Long session so login baar-baar na maange */
const ADMIN_TOKEN_EXPIRES = process.env.ADMIN_TOKEN_EXPIRES || '365d';
const CUSTOMER_TOKEN_EXPIRES = process.env.CUSTOMER_TOKEN_EXPIRES || '365d';
const DELIVERY_TOKEN_EXPIRES = process.env.DELIVERY_TOKEN_EXPIRES || '365d';

const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || 'kartikey parihar').trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '7518576269').trim();

/* old delivery panel compatibility */
const DELIVERY_DEMO_USERNAME = String(process.env.DELIVERY_DEMO_USERNAME || 'delivery').trim();
const DELIVERY_DEMO_PASSWORD = String(process.env.DELIVERY_DEMO_PASSWORD || '1234').trim();

const OTP_EXPIRY_MS = 5 * 60 * 1000;

const appDir = __dirname;
const publicDir = path.join(appDir, 'public');
const dataDir = path.join(appDir, 'data');
const uploadsDir = path.join(appDir, 'uploads');
const voiceUploadsDir = path.join(appDir, 'voice-uploads');

const productsFile = path.join(dataDir, 'products.json');
const ordersFile = path.join(dataDir, 'orders.json');
const deliveryUsersFile = path.join(dataDir, 'delivery-users.json');
const voiceOrdersFile = path.join(dataDir, 'voice-orders.json');
const offersFile = path.join(dataDir, 'offers.json');
const couponsFile = path.join(dataDir, 'coupons.json');

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
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

/* =========================
   FILE HELPERS
   ========================= */
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
ensureDir(voiceUploadsDir);
ensureFile(productsFile);
ensureFile(ordersFile);
ensureFile(deliveryUsersFile);
ensureFile(voiceOrdersFile);
ensureFile(offersFile);
ensureFile(couponsFile);

app.use('/uploads', express.static(uploadsDir));
app.use('/voice-uploads', express.static(voiceUploadsDir));
app.use(express.static(publicDir));

/* =========================
   BASIC HELPERS
   ========================= */
function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').trim();
}

function normalizeVillage(village) {
  return String(village || '').trim().toLowerCase();
}

function normalizeCouponCode(code) {
  return String(code || '').trim().toUpperCase();
}

function getVillageDeliveryCharge(village) {
  const key = normalizeVillage(village);
  return Object.prototype.hasOwnProperty.call(ALLOWED_VILLAGES, key)
    ? Number(ALLOWED_VILLAGES[key])
    : null;
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

function generateVoiceOrderId() {
  return 'VOICE' + Date.now();
}

function generateOfferId() {
  return 'OFF' + Date.now();
}

function generateCouponId() {
  return 'CPN' + Date.now();
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
  return {
    latitude: '',
    longitude: '',
    accuracy: 0,
    updatedAt: '',
    live: false
  };
}

function isOrderLiveTrackable(order) {
  const status = String(order?.status || '').trim().toLowerCase();
  return !['delivered', 'cancelled', 'canceled'].includes(status);
}

function normalizeOrderForResponse(order) {
  return {
    ...order,
    customerLocation: order.customerLocation || clearLiveLocation()
  };
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

function deleteVoiceByUrl(audioUrl) {
  try {
    if (!audioUrl || typeof audioUrl !== 'string') return;
    const cleanedUrl = audioUrl.split('?')[0];
    if (!cleanedUrl.includes('/voice-uploads/')) return;
    const fileName = path.basename(cleanedUrl);
    const filePath = path.join(voiceUploadsDir, fileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    console.error('Voice delete error:', error.message);
  }
}

/* =========================
   OFFERS / COUPONS HELPERS
   ========================= */
async function readOffers() {
  const jsonData = readJson(offersFile, []);

  return withFirestore(async () => {
    const snapshot = await db.collection('offers').get();
    return snapshot.docs.map((doc) => ({
      ...doc.data(),
      id: doc.data().id || doc.id
    }));
  }, jsonData, 'Firestore readOffers');
}

async function writeOffers(offers) {
  writeJson(offersFile, offers);

  if (!db || !firestoreEnabled) return;

  try {
    const batch = db.batch();
    const ref = db.collection('offers');
    const current = await ref.get();

    current.docs.forEach((doc) => batch.delete(doc.ref));
    offers.forEach((offer) => batch.set(ref.doc(String(offer.id)), offer));

    await batch.commit();
  } catch (error) {
    console.error('Firestore writeOffers error:', error.message);
    if (String(error.message || '').includes('5 NOT_FOUND')) {
      disableFirestore(error, 'Firestore writeOffers');
    }
  }
}

async function readCoupons() {
  const jsonData = readJson(couponsFile, []);

  return withFirestore(async () => {
    const snapshot = await db.collection('coupons').get();
    return snapshot.docs.map((doc) => ({
      ...doc.data(),
      id: doc.data().id || doc.id
    }));
  }, jsonData, 'Firestore readCoupons');
}

async function writeCoupons(coupons) {
  writeJson(couponsFile, coupons);

  if (!db || !firestoreEnabled) return;

  try {
    const batch = db.batch();
    const ref = db.collection('coupons');
    const current = await ref.get();

    current.docs.forEach((doc) => batch.delete(doc.ref));
    coupons.forEach((coupon) => batch.set(ref.doc(String(coupon.id)), coupon));

    await batch.commit();
  } catch (error) {
    console.error('Firestore writeCoupons error:', error.message);
    if (String(error.message || '').includes('5 NOT_FOUND')) {
      disableFirestore(error, 'Firestore writeCoupons');
    }
  }
}

function parseOfferDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isOfferExpired(offer) {
  const validTill = parseOfferDate(offer.validTill);
  if (!validTill) return false;
  return validTill.getTime() < Date.now();
}

async function cleanupExpiredOffers() {
  const offers = await readOffers();
  const activeOffers = [];

  for (const offer of offers) {
    if (isOfferExpired(offer)) {
      if (offer.image) deleteImageByUrl(offer.image);
      continue;
    }
    activeOffers.push(offer);
  }

  if (activeOffers.length !== offers.length) {
    await writeOffers(activeOffers);
  }

  return activeOffers;
}

function sanitizeOfferForResponse(offer) {
  return {
    ...offer,
    code: normalizeCouponCode(offer.code),
    isExpired: isOfferExpired(offer),
    subtitle: offer.description || offer.subtitle || ''
  };
}

function isCouponExpired(coupon) {
  const validTill = parseOfferDate(coupon.validTill);
  if (!validTill) return false;
  return validTill.getTime() < Date.now();
}

async function cleanupExpiredCoupons() {
  const coupons = await readCoupons();
  const activeCoupons = coupons.filter((coupon) => !isCouponExpired(coupon));
  if (activeCoupons.length !== coupons.length) {
    await writeCoupons(activeCoupons);
  }
  return activeCoupons;
}

function calculateCouponDiscount(subtotal, offer) {
  const numericSubtotal = Number(subtotal || 0);
  const discountType = String(offer.discountType || offer.type || 'percentage').trim().toLowerCase();
  const discountValue = Number(offer.discountValue ?? offer.discount ?? 0);
  const maxDiscount = Number(offer.maxDiscount || 0);
  const minOrderAmount = Number(offer.minOrderAmount || 0);

  if (numericSubtotal <= 0) {
    return { valid: false, message: 'Invalid subtotal', discountAmount: 0 };
  }

  if (numericSubtotal < minOrderAmount) {
    return {
      valid: false,
      message: `Minimum order ₹${minOrderAmount} required for this coupon`,
      discountAmount: 0
    };
  }

  let discountAmount = 0;

  if (discountType === 'flat') {
    discountAmount = discountValue;
  } else {
    discountAmount = (numericSubtotal * discountValue) / 100;
  }

  if (maxDiscount > 0) {
    discountAmount = Math.min(discountAmount, maxDiscount);
  }

  discountAmount = Math.max(0, Math.min(discountAmount, numericSubtotal));

  return {
    valid: discountAmount > 0,
    message: discountAmount > 0 ? 'Coupon applied successfully' : 'Coupon discount not valid',
    discountAmount: Math.round(discountAmount * 100) / 100
  };
}

/* =========================
   FIREBASE
   ========================= */
let serviceAccount = null;
let db = null;
let firestoreEnabled = false;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('Using FIREBASE_SERVICE_ACCOUNT from environment');
  } else {
    const keyPath = path.join(__dirname, 'firebase-service-account.json');
    if (fs.existsSync(keyPath)) {
      serviceAccount = require(keyPath);
      console.log('Using LOCAL firebase-service-account.json');
    }
  }

  if (serviceAccount) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id
      });
    }

    db = admin.firestore();
    firestoreEnabled = true;

    console.log('Firebase Firestore connected');
    console.log('Project:', serviceAccount.project_id);
    console.log('Database:', '(default)');
  } else {
    console.log('Firebase service account not found, using JSON backup only');
  }
} catch (error) {
  console.error('Firebase init failed:', error.message);
  db = null;
  firestoreEnabled = false;
}

function isFirestoreNotFoundError(error) {
  const msg = String(error?.message || '');
  return error?.code === 5 || msg.includes('5 NOT_FOUND') || msg.includes('NOT_FOUND');
}

function disableFirestore(error, label = 'Firestore') {
  console.error(`${label} disabled:`, error?.message || error);
  db = null;
  firestoreEnabled = false;
}

async function withFirestore(action, fallbackValue, label) {
  if (!db || !firestoreEnabled) return fallbackValue;

  try {
    return await action();
  } catch (error) {
    console.error(`${label} error:`, error.message);
    if (isFirestoreNotFoundError(error)) {
      disableFirestore(error, label);
    }
    return fallbackValue;
  }
}


/* =========================
   DATA READ/WRITE
   ========================= */
async function readProducts() {
  const jsonData = readJson(productsFile, []);

  return withFirestore(async () => {
    const snapshot = await db.collection('products').get();
    return snapshot.docs.map((doc) => ({
      ...doc.data(),
      id: Number(doc.data().id ?? doc.id)
    }));
  }, jsonData, 'Firestore readProducts');
}

async function writeProducts(products) {
  writeJson(productsFile, products);

  if (!db || !firestoreEnabled) return;

  try {
    const batch = db.batch();
    const ref = db.collection('products');
    const current = await ref.get();

    current.docs.forEach((doc) => batch.delete(doc.ref));
    products.forEach((product) => {
      batch.set(ref.doc(String(product.id)), product);
    });

    await batch.commit();
  } catch (error) {
    console.error('Firestore writeProducts error:', error.message);
    if (isFirestoreNotFoundError(error)) {
      disableFirestore(error, 'Firestore writeProducts');
    }
  }
}
async function readOrders() {
  const jsonData = readJson(ordersFile, []);

  return withFirestore(async () => {
    const snapshot = await db.collection('orders').get();
    return snapshot.docs.map((doc) => ({
      ...doc.data(),
      id: doc.data().id || doc.id
    }));
  }, jsonData, 'Firestore readOrders');
}

async function writeOrders(orders) {
  writeJson(ordersFile, orders);

  if (!db || !firestoreEnabled) return;

  try {
    const batch = db.batch();
    const ref = db.collection('orders');
    const current = await ref.get();

    current.docs.forEach((doc) => batch.delete(doc.ref));
    orders.forEach((order) => {
      batch.set(ref.doc(String(order.id)), order);
    });

    await batch.commit();
  } catch (error) {
    console.error('Firestore writeOrders error:', error.message);
    if (isFirestoreNotFoundError(error)) {
      disableFirestore(error, 'Firestore writeOrders');
    }
  }
}
async function readVoiceOrders() {
  const jsonData = readJson(voiceOrdersFile, []);

  return withFirestore(async () => {
    const snapshot = await db.collection('voiceOrders').get();
    return snapshot.docs.map((doc) => ({
      ...doc.data(),
      id: doc.data().id || doc.id
    }));
  }, jsonData, 'Firestore readVoiceOrders');
}

async function writeVoiceOrders(voiceOrders) {
  writeJson(voiceOrdersFile, voiceOrders);

  if (!db || !firestoreEnabled) return;

  try {
    const batch = db.batch();
    const ref = db.collection('voiceOrders');
    const current = await ref.get();

    current.docs.forEach((doc) => batch.delete(doc.ref));
    voiceOrders.forEach((item) => batch.set(ref.doc(String(item.id)), item));

    await batch.commit();
  } catch (error) {
    console.error('Firestore writeVoiceOrders error:', error.message);
    if (isFirestoreNotFoundError(error)) {
      disableFirestore(error, 'Firestore writeVoiceOrders');
    }
  }
}
async function readDeliveryUsers() {
  const jsonData = readJson(deliveryUsersFile, []);

  return withFirestore(async () => {
    const snapshot = await db.collection('deliveryUsers').get();
    return snapshot.docs.map((doc) => ({
      ...doc.data(),
      id: doc.data().id || doc.id
    }));
  }, jsonData, 'Firestore readDeliveryUsers');
}

async function writeDeliveryUsers(users) {
  writeJson(deliveryUsersFile, users);

  if (!db || !firestoreEnabled) return;

  try {
    const batch = db.batch();
    const ref = db.collection('deliveryUsers');
    const current = await ref.get();

    current.docs.forEach((doc) => batch.delete(doc.ref));
    users.forEach((user) => batch.set(ref.doc(String(user.id)), user));

    await batch.commit();
  } catch (error) {
    console.error('Firestore writeDeliveryUsers error:', error.message);
    if (isFirestoreNotFoundError(error)) {
      disableFirestore(error, 'Firestore writeDeliveryUsers');
    }
  }
}
/* =========================
   TOKENS / AUTH
   ========================= */
function createAdminToken() {
  return jwt.sign(
    { username: ADMIN_USERNAME, role: 'admin' },
    ADMIN_JWT_SECRET,
    { expiresIn: ADMIN_TOKEN_EXPIRES }
  );
}

function createCustomerToken(phone, village) {
  return jwt.sign(
    { phone, village, role: 'customer' },
    CUSTOMER_JWT_SECRET,
    { expiresIn: CUSTOMER_TOKEN_EXPIRES }
  );
}

function createDeliveryToken(deliveryUser) {
  return jwt.sign(
    {
      id: deliveryUser.id,
      name: deliveryUser.name,
      phone: deliveryUser.phone,
      role: 'delivery'
    },
    DELIVERY_JWT_SECRET,
    { expiresIn: DELIVERY_TOKEN_EXPIRES }
  );
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

/* =========================
   UPLOADS
   ========================= */
const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    const base = path.basename(file.originalname || 'image', ext).replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 40) || 'image';
    cb(null, `${Date.now()}-${base}${ext}`);
  }
});

const upload = multer({
  storage: imageStorage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

const voiceStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, voiceUploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.webm';
    const base = path.basename(file.originalname || 'voice', ext).replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 40) || 'voice';
    cb(null, `${Date.now()}-${base}${ext}`);
  }
});

const voiceUpload = multer({
  storage: voiceStorage,
  limits: { fileSize: 15 * 1024 * 1024 }
});

/* =========================
   HTML ROUTES
   ========================= */
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));
app.get('/delivery', (req, res) => res.sendFile(path.join(publicDir, 'delivery.html')));

/* =========================
   CUSTOMER AUTH
   ========================= */
app.post('/api/customer/request-otp', (req, res) => {
  const phone = normalizePhone(req.body.phone);

  if (!phone || phone.length < 10) {
    return res.status(400).json({ message: 'Valid mobile number required' });
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(phone, {
    otp,
    expiresAt: Date.now() + OTP_EXPIRY_MS
  });

  res.json({
    message: 'OTP sent successfully',
    demoOtp: otp,
    expiresInSeconds: 300
  });
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

  if (saved.otp !== otp) {
    return res.status(400).json({ message: 'Invalid OTP' });
  }

  const deliveryCharge = getVillageDeliveryCharge(village);
  if (deliveryCharge === null) {
    return res.status(400).json({ message: 'Currently not available this address' });
  }

  otpStore.delete(phone);

  const token = createCustomerToken(phone, village);

  res.json({
    message: 'Customer login successful',
    token,
    customer: { phone, village, deliveryCharge }
  });
});

app.get('/api/customer/me', requireCustomer, (req, res) => {
  res.json({
    customer: {
      phone: req.customer.phone,
      village: req.customer.village || ''
    }
  });
});

/* =========================
   ADMIN AUTH
   ========================= */
app.post('/api/admin/login', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '').trim();

  const adminUser = String(ADMIN_USERNAME || '').trim().toLowerCase();
  const adminPass = String(ADMIN_PASSWORD || '').trim();

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password required' });
  }

  if (username !== adminUser || password !== adminPass) {
    return res.status(401).json({ message: 'Invalid username or password' });
  }

  return res.json({
    message: 'Login successful',
    token: createAdminToken(),
    admin: { username: ADMIN_USERNAME }
  });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ admin: { username: ADMIN_USERNAME } });
});

/* =========================
   DELIVERY AUTH
   Supports BOTH old + new panel
   ========================= */
app.post('/api/delivery/request-access', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = normalizePhone(req.body.phone);

  if (!name || !phone || phone.length < 10) {
    return res.status(400).json({ message: 'Valid name and phone required' });
  }

  const deliveryUsers = await readDeliveryUsers();
  const existing = deliveryUsers.find((user) => normalizePhone(user.phone) === phone);

  if (existing) {
    if (existing.status === 'Approved') {
      return res.status(400).json({ message: 'This number is already approved. Please login.' });
    }
    if (existing.status === 'Pending Approval') {
      return res.status(400).json({ message: 'Your approval request is already pending.' });
    }
    return res.status(400).json({ message: 'This number already exists. Contact admin.' });
  }

  const newUser = {
    id: generateDeliveryId(),
    name,
    phone,
    username: '',
    password: '',
    status: 'Pending Approval',
    deviceId: '',
    createdAt: getISTDateTime(),
    approvedAt: '',
    updatedAt: getISTDateTime(),
    lastLoginAt: '',
    image: ''
  };

  deliveryUsers.unshift(newUser);
  await writeDeliveryUsers(deliveryUsers);

  res.status(201).json({
    message: 'Request sent to admin for approval',
    deliveryUser: newUser
  });
});

app.post('/api/delivery/login', async (req, res) => {
  const rawPhone = normalizePhone(req.body.phone);
  const deviceId = String(req.body.deviceId || '').trim();

  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '').trim();

  const deliveryUsers = await readDeliveryUsers();

  if (username || password) {
    if (username === DELIVERY_DEMO_USERNAME && password === DELIVERY_DEMO_PASSWORD) {
      let demoUser = deliveryUsers.find((u) => String(u.id) === 'DB-DEMO-DELIVERY');

      if (!demoUser) {
        demoUser = {
          id: 'DB-DEMO-DELIVERY',
          name: 'Delivery Boy',
          phone: '0000000000',
          username: DELIVERY_DEMO_USERNAME,
          password: DELIVERY_DEMO_PASSWORD,
          status: 'Approved',
          deviceId: '',
          createdAt: getISTDateTime(),
          approvedAt: getISTDateTime(),
          updatedAt: getISTDateTime(),
          lastLoginAt: '',
          image: ''
        };
        deliveryUsers.unshift(demoUser);
        await writeDeliveryUsers(deliveryUsers);
      }

      demoUser.lastLoginAt = getISTDateTime();
      demoUser.updatedAt = getISTDateTime();

      const idx = deliveryUsers.findIndex((u) => String(u.id) === demoUser.id);
      if (idx !== -1) {
        deliveryUsers[idx] = demoUser;
        await writeDeliveryUsers(deliveryUsers);
      }

      return res.json({
        message: 'Delivery login successful',
        token: createDeliveryToken(demoUser),
        delivery: {
          id: demoUser.id,
          name: demoUser.name,
          phone: demoUser.phone,
          status: demoUser.status
        }
      });
    }

    return res.status(401).json({ message: 'Invalid username or password' });
  }

  if (!rawPhone || rawPhone.length < 10) {
    return res.status(400).json({ message: 'Valid phone required' });
  }

  const index = deliveryUsers.findIndex((user) => normalizePhone(user.phone) === rawPhone);

  if (index === -1) {
    return res.status(404).json({ message: 'No delivery ID found for this number. First request approval.' });
  }

  const deliveryUser = deliveryUsers[index];

  if (deliveryUser.status === 'Pending Approval') {
    return res.status(403).json({ message: 'Your ID is waiting for admin approval.' });
  }

  if (deliveryUser.status !== 'Approved') {
    return res.status(403).json({ message: 'This delivery ID is not active.' });
  }

  if (deviceId) {
    if (deliveryUser.deviceId && deliveryUser.deviceId !== deviceId) {
      return res.status(403).json({ message: 'This ID is already active on another device. Contact admin.' });
    }
    if (!deliveryUser.deviceId) {
      deliveryUsers[index].deviceId = deviceId;
    }
  }

  deliveryUsers[index].lastLoginAt = getISTDateTime();
  deliveryUsers[index].updatedAt = getISTDateTime();

  await writeDeliveryUsers(deliveryUsers);

  const approvedUser = deliveryUsers[index];

  res.json({
    message: 'Delivery login successful',
    token: createDeliveryToken(approvedUser),
    delivery: {
      id: approvedUser.id,
      name: approvedUser.name,
      phone: approvedUser.phone,
      status: approvedUser.status,
      image: approvedUser.image || ''
    }
  });
});

app.get('/api/delivery/me', requireDelivery, async (req, res) => {
  const deliveryUsers = await readDeliveryUsers();
  const deliveryUser = deliveryUsers.find((user) => String(user.id) === String(req.delivery.id));

  if (!deliveryUser && String(req.delivery.id) === 'DB-DEMO-DELIVERY') {
    return res.json({
      delivery: {
        id: 'DB-DEMO-DELIVERY',
        name: req.delivery.name || 'Delivery Boy',
        phone: req.delivery.phone || '0000000000',
        status: 'Approved',
        image: ''
      }
    });
  }

  if (!deliveryUser || deliveryUser.status !== 'Approved') {
    return res.status(401).json({ message: 'Delivery ID not active' });
  }

  res.json({
    delivery: {
      id: deliveryUser.id,
      name: deliveryUser.name,
      phone: deliveryUser.phone,
      status: deliveryUser.status,
      image: deliveryUser.image || ''
    }
  });
});

/* =========================
   DELIVERY ADMIN MANAGEMENT
   ========================= */
app.get('/api/admin/delivery-users', requireAdmin, async (req, res) => {
  res.json(await readDeliveryUsers());
});

app.patch('/api/admin/delivery-users/:id', requireAdmin, async (req, res) => {
  const deliveryUsers = await readDeliveryUsers();
  const userId = String(req.params.id);
  const index = deliveryUsers.findIndex((user) => String(user.id) === userId);

  if (index === -1) return res.status(404).json({ message: 'Delivery ID not found' });

  const { action, name, phone, resetDevice, image } = req.body;

  if (name !== undefined) {
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ message: 'Valid name required' });
    deliveryUsers[index].name = cleanName;
  }

  if (phone !== undefined) {
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone || cleanPhone.length < 10) {
      return res.status(400).json({ message: 'Valid phone required' });
    }
    const duplicate = deliveryUsers.find((user, i) => i !== index && normalizePhone(user.phone) === cleanPhone);
    if (duplicate) return res.status(400).json({ message: 'This phone already exists' });
    deliveryUsers[index].phone = cleanPhone;
  }

  if (image !== undefined) {
    deliveryUsers[index].image = String(image || '').trim();
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

  await writeDeliveryUsers(deliveryUsers);

  res.json({
    message: 'Delivery ID updated successfully',
    deliveryUser: deliveryUsers[index]
  });
});

app.delete('/api/admin/delivery-users/:id', requireAdmin, async (req, res) => {
  const deliveryUsers = await readDeliveryUsers();
  const userId = String(req.params.id);
  const filtered = deliveryUsers.filter((user) => String(user.id) !== userId);

  if (filtered.length === deliveryUsers.length) {
    return res.status(404).json({ message: 'Delivery ID not found' });
  }

  await writeDeliveryUsers(filtered);
  res.json({ message: 'Delivery ID deleted successfully' });
});

/* =========================
   UPLOAD IMAGE
   ========================= */
app.post('/upload', requireAdmin, (req, res) => {
  upload.single('image')(req, res, (error) => {
    if (error) return res.status(400).json({ message: error.message || 'Image upload failed' });
    if (!req.file) return res.status(400).json({ message: 'No image file uploaded' });

    res.status(201).json({
      message: 'Image uploaded successfully',
      imageUrl: `/uploads/${req.file.filename}`
    });
  });
});

/* =========================
   PRODUCTS
   ========================= */
app.get('/api/products', async (req, res) => {
  const products = await readProducts();
  res.json(Array.isArray(products) ? products : []);
});

app.post('/api/products', requireAdmin, async (req, res) => {
  const products = await readProducts();
  const { name, price, original, image, category, stock, active } = req.body;

  if (!name || !price) {
    return res.status(400).json({ message: 'Product name and price are required' });
  }

  const numericPrice = Number(price);
  const numericOriginal = Number(original || price);
  const numericStock = Number(stock || 0);

  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    return res.status(400).json({ message: 'Valid product price is required' });
  }

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

  res.status(201).json({
    message: 'Product added successfully',
    product
  });
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

  if (oldProduct.image && updated.image !== oldProduct.image && updated.image) {
    deleteImageByUrl(oldProduct.image);
  }

  products[index] = updated;
  await writeProducts(products);

  res.json({
    message: 'Product updated successfully',
    product: updated
  });
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

/* =========================
   OFFERS / COUPONS ROUTES
   ========================= */

/* customer active offers */
app.get('/api/offers', async (req, res) => {
  const offers = (await cleanupExpiredOffers())
    .filter((offer) => String(offer.isActive ?? true) !== 'false')
    .map(sanitizeOfferForResponse);

  res.json(offers);
});

/* admin all offers */
app.get('/api/admin/offers', requireAdmin, async (req, res) => {
  const offers = (await cleanupExpiredOffers()).map(sanitizeOfferForResponse);
  res.json(offers);
});

/* add offer */
app.post('/api/admin/offers', requireAdmin, async (req, res) => {
  const offers = await cleanupExpiredOffers();

  const image = String(req.body.image || '').trim();
  const title = String(req.body.title || '').trim();
  const code = normalizeCouponCode(req.body.code);
  const discountTypeRaw = String(req.body.discountType || req.body.type || 'percentage').trim().toLowerCase();
  const discountType = ['flat', 'percentage', 'percent'].includes(discountTypeRaw)
    ? (discountTypeRaw === 'percent' ? 'percentage' : discountTypeRaw)
    : 'percentage';
  const discountValue = Number(req.body.discountValue ?? req.body.discount ?? 0);
  const minOrderAmount = Number(req.body.minOrderAmount || 0);
  const maxDiscount = Number(req.body.maxDiscount || 0);
  const validTill = String(req.body.validTill || '').trim();
  const description = String(req.body.description || req.body.subtitle || '').trim();

  if (!image) return res.status(400).json({ message: 'Offer image required' });
  if (!title) return res.status(400).json({ message: 'Offer title required' });
  if (!code) return res.status(400).json({ message: 'Coupon code required' });
  if (!Number.isFinite(discountValue) || discountValue <= 0) {
    return res.status(400).json({ message: 'Valid discount value required' });
  }
  if (offers.some((offer) => normalizeCouponCode(offer.code) === code)) {
    return res.status(400).json({ message: 'Coupon code already exists' });
  }

  const validTillDate = parseOfferDate(validTill);
  if (!validTillDate) {
    return res.status(400).json({ message: 'Valid expiry date required' });
  }
  if (validTillDate.getTime() <= Date.now()) {
    return res.status(400).json({ message: 'Expiry date must be in the future' });
  }

  const offer = {
    id: generateOfferId(),
    image,
    title,
    description,
    subtitle: description,
    code,
    discountType,
    discountValue,
    discount: discountValue,
    minOrderAmount: Number.isFinite(minOrderAmount) ? minOrderAmount : 0,
    maxDiscount: Number.isFinite(maxDiscount) ? maxDiscount : 0,
    validTill: validTillDate.toISOString(),
    isActive: true,
    createdAt: getISTDateTime(),
    updatedAt: getISTDateTime()
  };

  offers.unshift(offer);
  await writeOffers(offers);

  return res.status(201).json({
    message: 'Offer created successfully',
    offer: sanitizeOfferForResponse(offer)
  });
});

/* update offer */
app.put('/api/admin/offers/:id', requireAdmin, async (req, res) => {
  const offers = await cleanupExpiredOffers();
  const offerId = String(req.params.id || '').trim();
  const index = offers.findIndex((offer) => String(offer.id) === offerId);

  if (index === -1) return res.status(404).json({ message: 'Offer not found' });

  const oldOffer = offers[index];

  const nextCode = req.body.code !== undefined ? normalizeCouponCode(req.body.code) : oldOffer.code;
  if (!nextCode) return res.status(400).json({ message: 'Coupon code required' });

  const duplicate = offers.find((offer, i) => i !== index && normalizeCouponCode(offer.code) === nextCode);
  if (duplicate) return res.status(400).json({ message: 'Coupon code already exists' });

  const nextDiscountTypeRaw = req.body.discountType !== undefined || req.body.type !== undefined
    ? String(req.body.discountType || req.body.type || '').trim().toLowerCase()
    : oldOffer.discountType;
  const nextDiscountType = nextDiscountTypeRaw === 'percent' ? 'percentage' : nextDiscountTypeRaw;

  if (!['percentage', 'flat'].includes(nextDiscountType)) {
    return res.status(400).json({ message: 'Valid discount type required' });
  }

  const nextDiscountValue = req.body.discountValue !== undefined || req.body.discount !== undefined
    ? Number(req.body.discountValue ?? req.body.discount)
    : Number(oldOffer.discountValue || oldOffer.discount || 0);

  if (!Number.isFinite(nextDiscountValue) || nextDiscountValue <= 0) {
    return res.status(400).json({ message: 'Valid discount value required' });
  }

  const nextValidTill = req.body.validTill !== undefined ? String(req.body.validTill || '').trim() : oldOffer.validTill;
  const validTillDate = parseOfferDate(nextValidTill);
  if (!validTillDate) return res.status(400).json({ message: 'Valid expiry date required' });

  const nextDescription = req.body.description !== undefined || req.body.subtitle !== undefined
    ? String(req.body.description || req.body.subtitle || '').trim()
    : oldOffer.description;

  const updatedOffer = {
    ...oldOffer,
    image: req.body.image !== undefined ? String(req.body.image || '').trim() : oldOffer.image,
    title: req.body.title !== undefined ? String(req.body.title || '').trim() : oldOffer.title,
    description: nextDescription,
    subtitle: nextDescription,
    code: nextCode,
    discountType: nextDiscountType,
    discountValue: nextDiscountValue,
    discount: nextDiscountValue,
    minOrderAmount: req.body.minOrderAmount !== undefined ? Number(req.body.minOrderAmount || 0) : Number(oldOffer.minOrderAmount || 0),
    maxDiscount: req.body.maxDiscount !== undefined ? Number(req.body.maxDiscount || 0) : Number(oldOffer.maxDiscount || 0),
    validTill: validTillDate.toISOString(),
    isActive: req.body.isActive !== undefined ? Boolean(req.body.isActive) : oldOffer.isActive,
    updatedAt: getISTDateTime()
  };

  if (!updatedOffer.image) return res.status(400).json({ message: 'Offer image required' });
  if (!updatedOffer.title) return res.status(400).json({ message: 'Offer title required' });

  offers[index] = updatedOffer;
  await writeOffers(offers);

  res.json({
    message: 'Offer updated successfully',
    offer: sanitizeOfferForResponse(updatedOffer)
  });
});

/* delete offer */
app.delete('/api/admin/offers/:id', requireAdmin, async (req, res) => {
  const offers = await cleanupExpiredOffers();
  const offerId = String(req.params.id || '').trim();
  const offer = offers.find((item) => String(item.id) === offerId);

  if (!offer) return res.status(404).json({ message: 'Offer not found' });

  if (offer.image) deleteImageByUrl(offer.image);

  const filtered = offers.filter((item) => String(item.id) !== offerId);
  await writeOffers(filtered);

  res.json({ message: 'Offer deleted successfully' });
});

/* admin coupons list */
app.get('/api/admin/coupons', requireAdmin, async (req, res) => {
  const coupons = await cleanupExpiredCoupons();
  res.json(coupons);
});

/* add coupon */
app.post('/api/admin/coupons', requireAdmin, async (req, res) => {
  const coupons = await cleanupExpiredCoupons();

  const code = normalizeCouponCode(req.body.code);
  const discount = Number(req.body.discount ?? req.body.discountValue ?? 0);
  const maxUsers = Number(req.body.maxUsers || 0);
  const typeRaw = String(req.body.type || req.body.discountType || 'flat').trim().toLowerCase();
  const type = typeRaw === 'percentage' ? 'percent' : typeRaw;
  const validTill = String(req.body.validTill || '').trim();

  if (!code) return res.status(400).json({ message: 'Coupon code required' });
  if (!Number.isFinite(discount) || discount <= 0) return res.status(400).json({ message: 'Valid discount required' });
  if (!Number.isFinite(maxUsers) || maxUsers <= 0) return res.status(400).json({ message: 'Valid max users required' });
  if (!['flat', 'percent'].includes(type)) {
    return res.status(400).json({ message: 'Type must be flat or percent' });
  }

  if (coupons.some((item) => normalizeCouponCode(item.code) === code)) {
    return res.status(400).json({ message: 'Coupon code already exists' });
  }

  const validTillDate = parseOfferDate(validTill);
  if (!validTillDate) {
    return res.status(400).json({ message: 'Valid expiry date required' });
  }
  if (validTillDate.getTime() <= Date.now()) {
    return res.status(400).json({ message: 'Expiry date must be in the future' });
  }

  const coupon = {
    id: generateCouponId(),
    code,
    discount,
    discountValue: discount,
    maxUsers,
    usedUsers: 0,
    type,
    discountType: type === 'percent' ? 'percentage' : 'flat',
    validTill: validTillDate.toISOString(),
    createdAt: getISTDateTime(),
    updatedAt: getISTDateTime()
  };

  coupons.unshift(coupon);
  await writeCoupons(coupons);

  res.status(201).json({
    message: 'Coupon saved successfully',
    coupon
  });
});

/* delete coupon */
app.delete('/api/admin/coupons/:id', requireAdmin, async (req, res) => {
  const coupons = await cleanupExpiredCoupons();
  const couponId = String(req.params.id || '').trim();
  const coupon = coupons.find((item) => String(item.id) === couponId);

  if (!coupon) return res.status(404).json({ message: 'Coupon not found' });

  const filtered = coupons.filter((item) => String(item.id) !== couponId);
  await writeCoupons(filtered);

  res.json({ message: 'Coupon deleted successfully' });
});

/* coupon validate from offers */
app.post('/api/coupons/validate', async (req, res) => {
  const subtotal = Number(req.body.subtotal || req.body.total || 0);
  const code = normalizeCouponCode(req.body.code);

  if (!code) return res.status(400).json({ message: 'Coupon code required' });
  if (!Number.isFinite(subtotal) || subtotal <= 0) {
    return res.status(400).json({ message: 'Valid subtotal required' });
  }

  const offers = await cleanupExpiredOffers();
  const offer = offers.find((item) => normalizeCouponCode(item.code) === code && item.isActive !== false);

  if (!offer) {
    return res.status(404).json({ valid: false, message: 'Invalid or expired coupon' });
  }

  const result = calculateCouponDiscount(subtotal, offer);

  if (!result.valid) {
    return res.status(400).json({
      valid: false,
      message: result.message,
      discountAmount: 0
    });
  }

  res.json({
    valid: true,
    message: result.message,
    coupon: {
      id: offer.id,
      title: offer.title,
      code: offer.code,
      discountType: offer.discountType,
      discountValue: offer.discountValue,
      minOrderAmount: Number(offer.minOrderAmount || 0),
      maxDiscount: Number(offer.maxDiscount || 0),
      validTill: offer.validTill
    },
    discountAmount: result.discountAmount
  });
});

/* coupon validate from coupons */
app.post('/api/admin/coupons/validate', requireAdmin, async (req, res) => {
  const subtotal = Number(req.body.subtotal || req.body.total || 0);
  const code = normalizeCouponCode(req.body.code);

  if (!code) return res.status(400).json({ message: 'Coupon code required' });
  if (!Number.isFinite(subtotal) || subtotal <= 0) {
    return res.status(400).json({ message: 'Valid subtotal required' });
  }

  const coupons = await cleanupExpiredCoupons();
  const coupon = coupons.find((item) => normalizeCouponCode(item.code) === code);

  if (!coupon) {
    return res.status(404).json({ valid: false, message: 'Invalid or expired coupon' });
  }

  if (Number(coupon.usedUsers || 0) >= Number(coupon.maxUsers || 0)) {
    return res.status(400).json({ valid: false, message: 'Coupon usage limit reached' });
  }

  let discountAmount = 0;
  if (coupon.type === 'percent') {
    discountAmount = (subtotal * Number(coupon.discount || 0)) / 100;
  } else {
    discountAmount = Number(coupon.discount || 0);
  }

  discountAmount = Math.max(0, Math.min(discountAmount, subtotal));

  res.json({
    valid: true,
    message: 'Coupon applied successfully',
    coupon,
    discountAmount
  });
});

/* =========================
   CUSTOMER ORDERS
   ========================= */
app.post('/api/orders', requireCustomer, async (req, res) => {
  const phone = normalizePhone(req.customer.phone);
  const village = normalizeVillage(req.customer.village);
  const { name, address, paymentMethod, items, customerLocation, couponCode } = req.body;

  if (!String(name || '').trim()) {
    return res.status(400).json({ message: 'Customer name required' });
  }

  if (!String(address || '').trim()) {
    return res.status(400).json({ message: 'Delivery address required' });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'Order items required' });
  }

  const products = await readProducts();
  const orders = await readOrders();

  const finalItems = [];
  let subtotal = 0;

  for (const item of items) {
    const productId = String(item.id || '').trim();
    const qty = Number(item.qty || 0);

    if (!productId || !Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ message: 'Invalid item data' });
    }

    const productIndex = products.findIndex((p) => String(p.id) === productId);
    if (productIndex === -1) {
      return res.status(404).json({ message: 'One or more products not found' });
    }

    const product = products[productIndex];
    const stock = Number(product.stock || 0);

    if (qty > stock) {
      return res.status(400).json({ message: `${product.name || 'Product'} is out of stock or insufficient quantity` });
    }

    const price = Number(product.price || 0);
    const originalPrice = Number(product.original || price || 0);

    finalItems.push({
      id: product.id,
      name: product.name || '',
      price,
      originalPrice,
      qty,
      image: product.image || '',
      category: product.category || ''
    });

    subtotal += price * qty;
  }

  const shipping = Number(getVillageDeliveryCharge(village) || 0);
  const cleanPaymentMethod = String(paymentMethod || 'cod').trim().toLowerCase() === 'upi' ? 'UPI' : 'COD';
  const cleanCustomerLocation = sanitizeLocation(customerLocation);

  let coupon = null;
  let couponDiscount = 0;
  const cleanCouponCode = normalizeCouponCode(couponCode);

  if (cleanCouponCode) {
    const offers = await cleanupExpiredOffers();
    const offer = offers.find((item) => normalizeCouponCode(item.code) === cleanCouponCode && item.isActive !== false);

    if (!offer) {
      const coupons = await cleanupExpiredCoupons();
      const altCoupon = coupons.find((item) => normalizeCouponCode(item.code) === cleanCouponCode);

      if (!altCoupon) {
        return res.status(400).json({ message: 'Invalid or expired coupon code' });
      }

      if (Number(altCoupon.usedUsers || 0) >= Number(altCoupon.maxUsers || 0)) {
        return res.status(400).json({ message: 'Coupon usage limit reached' });
      }

      if (altCoupon.type === 'percent') {
        couponDiscount = Math.max(0, Math.min((subtotal * Number(altCoupon.discount || 0)) / 100, subtotal));
      } else {
        couponDiscount = Math.max(0, Math.min(Number(altCoupon.discount || 0), subtotal));
      }

      coupon = {
        id: altCoupon.id,
        title: altCoupon.code,
        code: altCoupon.code,
        discountType: altCoupon.type === 'percent' ? 'percentage' : 'flat',
        discountValue: altCoupon.discount
      };

      const couponIndex = coupons.findIndex((item) => String(item.id) === String(altCoupon.id));
      if (couponIndex !== -1) {
        coupons[couponIndex].usedUsers = Number(coupons[couponIndex].usedUsers || 0) + 1;
        coupons[couponIndex].updatedAt = getISTDateTime();
        await writeCoupons(coupons);
      }
    } else {
      const couponResult = calculateCouponDiscount(subtotal, offer);
      if (!couponResult.valid) {
        return res.status(400).json({ message: couponResult.message });
      }

      coupon = {
        id: offer.id,
        title: offer.title,
        code: offer.code,
        discountType: offer.discountType,
        discountValue: offer.discountValue
      };
      couponDiscount = couponResult.discountAmount;
    }
  }

  const total = Math.max(0, subtotal - couponDiscount) + shipping;

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
    couponCode: cleanCouponCode || '',
    couponDiscount,
    coupon,
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
    if (idx !== -1) {
      products[idx].stock = Math.max(0, Number(products[idx].stock || 0) - Number(item.qty || 0));
    }
  }

  orders.unshift(newOrder);
  await writeProducts(products);
  await writeOrders(orders);

  res.status(201).json({
    message: 'Order placed successfully',
    order: normalizeOrderForResponse(newOrder)
  });
});

app.get('/api/my-orders', requireCustomer, async (req, res) => {
  const phone = normalizePhone(req.customer.phone);
  const orders = await readOrders();

  const customerOrders = orders
    .filter((order) => normalizePhone(order.phone) === phone)
    .map(normalizeOrderForResponse);

  res.json(customerOrders);
});

app.patch('/api/customer/location', requireCustomer, async (req, res) => {
  const phone = normalizePhone(req.customer.phone);
  const nextLocation = sanitizeLocation(req.body);

  if (!nextLocation) {
    return res.status(400).json({ message: 'Valid customer location required' });
  }

  const orders = await readOrders();
  let updatedCount = 0;

  for (const order of orders) {
    if (normalizePhone(order.phone) !== phone) continue;
    if (!isOrderLiveTrackable(order)) continue;
    order.customerLocation = { ...nextLocation };
    updatedCount += 1;
  }

  await writeOrders(orders);

  res.json({
    message: 'Customer live location updated',
    updatedCount
  });
});

/* =========================
   ADMIN ORDERS
   ========================= */
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
    if (!validPaymentStatuses.includes(paymentStatus)) {
      return res.status(400).json({ message: 'Invalid payment status' });
    }
    orders[index].paymentStatus = paymentStatus;
  }

  await writeOrders(orders);

  res.json({
    message: 'Order updated successfully',
    order: normalizeOrderForResponse(orders[index])
  });
});

app.patch('/api/admin/orders/:id/confirm', requireAdmin, async (req, res) => {
  const orders = await readOrders();
  const orderId = String(req.params.id || '').trim();
  const index = orders.findIndex((o) => String(o.id) === orderId);

  if (index === -1) return res.status(404).json({ message: 'Order not found' });

  orders[index].status = 'Pending';
  await writeOrders(orders);

  res.json({
    message: 'Order confirmed successfully',
    order: normalizeOrderForResponse(orders[index])
  });
});

app.patch('/api/admin/orders/:id/assign-delivery', requireAdmin, async (req, res) => {
  const orders = await readOrders();
  const deliveryUsers = await readDeliveryUsers();
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

  if (orders[orderIndex].status === 'Need Confirmation') {
    orders[orderIndex].status = 'Pending';
  }

  await writeOrders(orders);

  res.json({
    message: 'Delivery boy assigned successfully',
    order: normalizeOrderForResponse(orders[orderIndex])
  });
});

app.put('/api/orders/:id/payment-status', requireAdmin, async (req, res) => {
  const orders = await readOrders();
  const orderId = String(req.params.id || '').trim();
  const { paymentStatus } = req.body;
  const validPaymentStatuses = ['COD', 'Payment Pending', 'Payment Confirmed'];
  const index = orders.findIndex((o) => String(o.id) === orderId);

  if (index === -1) return res.status(404).json({ message: 'Order not found' });
  if (!paymentStatus || !validPaymentStatuses.includes(paymentStatus)) {
    return res.status(400).json({ message: 'Invalid payment status' });
  }

  orders[index].paymentStatus = paymentStatus;
  await writeOrders(orders);

  res.json({
    message: 'Payment status updated successfully',
    order: normalizeOrderForResponse(orders[index])
  });
});

app.delete('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const orders = await readOrders();
  const orderId = String(req.params.id || '').trim();
  const filteredOrders = orders.filter((o) => String(o.id) !== orderId);

  if (filteredOrders.length === orders.length) {
    return res.status(404).json({ message: 'Order not found' });
  }

  await writeOrders(filteredOrders);
  res.json({ message: 'Order deleted successfully' });
});

/* =========================
   DELIVERY ORDERS
   ========================= */
app.get('/api/delivery/orders', requireDelivery, async (req, res) => {
  const orders = await readOrders();
  const deliveryId = String(req.delivery.id || '').trim();

  let deliveryOrders = [];

  if (deliveryId === 'DB-DEMO-DELIVERY') {
    deliveryOrders = orders.filter((order) => ['Pending', 'Out for Delivery', 'Delivered'].includes(String(order.status || '')));
  } else {
    deliveryOrders = orders.filter((order) => {
      return String(order.assignedDeliveryBoyId || order.deliveryBoyId || '').trim() === deliveryId;
    });
  }

  res.json(deliveryOrders.map(normalizeOrderForResponse));
});

async function handleDeliveryStatusUpdate(req, res) {
  const orderId = String(req.params.id || '').trim();
  const status = String(req.body.status || '').trim();
  const allowedStatuses = ['Pending', 'Out for Delivery', 'Delivered'];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ message: 'Invalid order status' });
  }

  const orders = await readOrders();
  const index = orders.findIndex((order) => String(order.id) === orderId);

  if (index === -1) return res.status(404).json({ message: 'Order not found' });

  const deliveryId = String(req.delivery.id || '').trim();
  const assignedId = String(orders[index].assignedDeliveryBoyId || orders[index].deliveryBoyId || '').trim();

  if (deliveryId !== 'DB-DEMO-DELIVERY' && assignedId !== deliveryId) {
    return res.status(403).json({ message: 'This order is not assigned to you' });
  }

  orders[index].status = status;

  if (deliveryId !== 'DB-DEMO-DELIVERY') {
    orders[index].deliveryBoyId = req.delivery.id || orders[index].deliveryBoyId || '';
    orders[index].deliveryBoyName = req.delivery.name || orders[index].deliveryBoyName || '';
    orders[index].deliveryBoyPhone = req.delivery.phone || orders[index].deliveryBoyPhone || '';
  }

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

  res.json({
    message: 'Order status updated successfully',
    order: normalizeOrderForResponse(orders[index])
  });
}

app.patch('/api/delivery/orders/:id/status', requireDelivery, handleDeliveryStatusUpdate);
app.put('/api/delivery/orders/:id/status', requireDelivery, handleDeliveryStatusUpdate);

/* =========================
   VOICE ORDERS
   ========================= */
app.post('/api/customer/voice-order', requireCustomer, (req, res) => {
  voiceUpload.single('audio')(req, res, async (error) => {
    if (error) return res.status(400).json({ message: error.message || 'Voice upload failed' });

    const phone = normalizePhone(req.customer.phone);
    const village = normalizeVillage(req.customer.village);

    const name = String(req.body.name || '').trim();
    const address = String(req.body.address || '').trim();
    const landmark = String(req.body.landmark || '').trim();
    const language = String(req.body.language || 'hi').trim();
    const customerLocation = sanitizeLocation({
      latitude: req.body.latitude,
      longitude: req.body.longitude,
      accuracy: req.body.accuracy
    });

    if (!name) return res.status(400).json({ message: 'Customer name required' });
    if (!address) return res.status(400).json({ message: 'Address required' });
    if (!req.file) return res.status(400).json({ message: 'Audio file required' });

    const shipping = Number(getVillageDeliveryCharge(village) || 0);
    const voiceOrders = await readVoiceOrders();

    const newVoiceOrder = {
      id: generateVoiceOrderId(),
      name,
      phone,
      village,
      address,
      landmark,
      language,
      shipping,
      status: 'New',
      audioUrl: `/voice-uploads/${req.file.filename}`,
      audioFileName: req.file.filename,
      customerLocation: customerLocation || clearLiveLocation(),
      createdAt: getISTDateTime(),
      createdAtISO: getNowISO(),
      adminNote: ''
    };

    voiceOrders.unshift(newVoiceOrder);
    await writeVoiceOrders(voiceOrders);

    res.status(201).json({
      message: 'Voice order sent successfully',
      voiceOrder: newVoiceOrder
    });
  });
});

app.post('/api/customer/voice-order-base64', requireCustomer, async (req, res) => {
  try {
    const phone = normalizePhone(req.customer.phone);
    const village = normalizeVillage(req.customer.village);

    const name = String(req.body.name || '').trim();
    const address = String(req.body.address || '').trim();
    const landmark = String(req.body.landmark || '').trim();
    const language = String(req.body.language || 'hi').trim();
    const audioBase64 = String(req.body.audioBase64 || '').trim();

    if (!name) return res.status(400).json({ message: 'Customer name required' });
    if (!address) return res.status(400).json({ message: 'Address required' });
    if (!audioBase64.startsWith('data:audio/')) {
      return res.status(400).json({ message: 'Valid base64 audio required' });
    }

    const matches = audioBase64.match(/^data:(audio\/[^;]+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ message: 'Invalid audio format' });

    const mimeType = matches[1];
    const base64Data = matches[2];

    let ext = '.webm';
    if (mimeType.includes('mpeg')) ext = '.mp3';
    else if (mimeType.includes('wav')) ext = '.wav';
    else if (mimeType.includes('ogg')) ext = '.ogg';
    else if (mimeType.includes('mp4')) ext = '.m4a';

    const fileName = `${Date.now()}-voice${ext}`;
    const filePath = path.join(voiceUploadsDir, fileName);

    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

    const customerLocation = sanitizeLocation({
      latitude: req.body.latitude,
      longitude: req.body.longitude,
      accuracy: req.body.accuracy
    });

    const shipping = Number(getVillageDeliveryCharge(village) || 0);
    const voiceOrders = await readVoiceOrders();

    const newVoiceOrder = {
      id: generateVoiceOrderId(),
      name,
      phone,
      village,
      address,
      landmark,
      language,
      shipping,
      status: 'New',
      audioUrl: `/voice-uploads/${fileName}`,
      audioFileName: fileName,
      customerLocation: customerLocation || clearLiveLocation(),
      createdAt: getISTDateTime(),
      createdAtISO: getNowISO(),
      adminNote: ''
    };

    voiceOrders.unshift(newVoiceOrder);
    await writeVoiceOrders(voiceOrders);

    res.status(201).json({
      message: 'Voice order sent successfully',
      voiceOrder: newVoiceOrder
    });
  } catch (error) {
    console.error('Voice base64 save error:', error.message);
    res.status(500).json({ message: 'Voice order save failed' });
  }
});

app.get('/api/admin/voice-orders', requireAdmin, async (req, res) => {
  res.json(await readVoiceOrders());
});

app.patch('/api/admin/voice-orders/:id', requireAdmin, async (req, res) => {
  const voiceOrders = await readVoiceOrders();
  const voiceOrderId = String(req.params.id || '').trim();
  const index = voiceOrders.findIndex((item) => String(item.id) === voiceOrderId);

  if (index === -1) return res.status(404).json({ message: 'Voice order not found' });

  const status = String(req.body.status || '').trim();
  const adminNote = req.body.adminNote !== undefined ? String(req.body.adminNote || '').trim() : undefined;

  const validStatuses = ['New', 'Seen', 'Contacted', 'Completed', 'Rejected'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ message: 'Invalid voice order status' });
  }

  if (status) voiceOrders[index].status = status;
  if (adminNote !== undefined) voiceOrders[index].adminNote = adminNote;
  voiceOrders[index].updatedAt = getISTDateTime();

  await writeVoiceOrders(voiceOrders);

  res.json({
    message: 'Voice order updated successfully',
    voiceOrder: voiceOrders[index]
  });
});

app.delete('/api/admin/voice-orders/:id', requireAdmin, async (req, res) => {
  const voiceOrders = await readVoiceOrders();
  const voiceOrderId = String(req.params.id || '').trim();
  const voiceOrder = voiceOrders.find((item) => String(item.id) === voiceOrderId);

  if (!voiceOrder) return res.status(404).json({ message: 'Voice order not found' });

  if (voiceOrder.audioUrl) deleteVoiceByUrl(voiceOrder.audioUrl);

  const filtered = voiceOrders.filter((item) => String(item.id) !== voiceOrderId);
  await writeVoiceOrders(filtered);

  res.json({ message: 'Voice order deleted successfully' });
});

app.get('/test-firebase', async (req, res) => {
  try {
    if (!db || !firestoreEnabled) {
      return res.status(500).json({
        ok: false,
        message: 'Firebase not connected',
        firestoreConnected: false
      });
    }

    const ref = db.collection('test').doc('check');

    await ref.set({
      message: 'Firebase connected',
      time: new Date().toISOString()
    }, { merge: true });

    const snap = await ref.get();

    return res.json({
      ok: true,
      firestoreConnected: true,
      projectId: serviceAccount?.project_id || '',
      data: snap.exists ? snap.data() : null
    });
  } catch (error) {
    console.error('Firestore test connection error:', error.message);

    if (isFirestoreNotFoundError(error)) {
      disableFirestore(error, 'Firestore test route');
    }

    return res.status(500).json({
      ok: false,
      firestoreConnected: false,
      message: error.message || 'Firestore test failed',
      code: error.code || ''
    });
  }
});
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Mode: ${firestoreEnabled ? 'Firestore + JSON backup' : 'Local JSON fallback'}`);
});