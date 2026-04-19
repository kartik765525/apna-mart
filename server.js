const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");
const serviceAccount = require("./firebase-service-account.json");

const app = express();
const PORT = process.env.PORT || 5000;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const ADMIN_JWT_SECRET = "apna_mart_admin_secret_2026";
const CUSTOMER_JWT_SECRET = "apna_mart_customer_secret_2026";
const DELIVERY_JWT_SECRET = "apna_mart_delivery_secret_2026";

const ADMIN_USERNAME = "kartikey parihar";
const ADMIN_PASSWORD = "7518576269";

const OTP_EXPIRY_MS = 5 * 60 * 1000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const dataDir = path.join(__dirname, "data");
const uploadsDir = path.join(__dirname, "uploads");
const publicDir = path.join(__dirname, "public");

const deliveryUsersFile = path.join(dataDir, "delivery-users.json");

const otpStore = new Map();

/* VILLAGE DELIVERY CONFIG */
const ALLOWED_VILLAGES = {
  "bihar": 5,
  "narayan nagla": 7,
  "bankati": 10,
  "gadi": 11,
  "kattina": 15,
  "kudiyani": 10,
  "rupnagar": 15,
  "pakadiya": 15,
  "tiliyani": 15
};

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureFile(filePath) {
  ensureDir(path.dirname(filePath));
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "[]", "utf-8");
  }
}

function readJson(filePath) {
  try {
    ensureFile(filePath);
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data || "[]");
  } catch (error) {
    console.error("Read error:", error);
    return [];
  }
}

function writeJson(filePath, data) {
  try {
    ensureFile(filePath);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    console.error("Write error:", error);
  }
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "").trim();
}

function normalizeVillage(village) {
  return String(village || "").trim().toLowerCase();
}

function getVillageDeliveryCharge(village) {
  const normalizedVillage = normalizeVillage(village);
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_VILLAGES, normalizedVillage)) {
    return null;
  }
  return Number(ALLOWED_VILLAGES[normalizedVillage]);
}

function getISTDateTime() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });
}

function generateOrderId() {
  return "ORD" + Date.now();
}

function sanitizeLocation(location) {
  if (!location || typeof location !== "object") return null;

  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  const accuracy = Number(location.accuracy || 0);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

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
    latitude: "",
    longitude: "",
    accuracy: 0,
    updatedAt: "",
    live: false
  };
}

function isOrderLiveTrackable(order) {
  const status = String(order?.status || "").trim().toLowerCase();
  return status !== "delivered" && status !== "cancelled" && status !== "canceled";
}

function normalizeOrderForResponse(order) {
  return {
    ...order,
    customerLocation: order.customerLocation || clearLiveLocation()
  };
}

function deleteImageByUrl(imageUrl) {
  try {
    if (!imageUrl || typeof imageUrl !== "string") return;

    const cleanedUrl = imageUrl.split("?")[0];
    if (!cleanedUrl.includes("/uploads/")) return;

    const fileName = path.basename(cleanedUrl);
    const filePath = path.join(uploadsDir, fileName);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error("Image delete error:", error);
  }
}

function createAdminToken() {
  return jwt.sign(
    { username: ADMIN_USERNAME, role: "admin" },
    ADMIN_JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function createCustomerToken(phone, village) {
  return jwt.sign(
    { phone, village, role: "customer" },
    CUSTOMER_JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function createDeliveryToken(deliveryUser) {
  return jwt.sign(
    {
      id: deliveryUser.id,
      name: deliveryUser.name,
      phone: deliveryUser.phone,
      role: "delivery"
    },
    DELIVERY_JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    return res.status(401).json({ message: "Admin login required" });
  }

  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired admin token" });
  }
}

function requireCustomer(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    return res.status(401).json({ message: "Customer login required" });
  }

  try {
    const decoded = jwt.verify(token, CUSTOMER_JWT_SECRET);
    req.customer = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired customer token" });
  }
}

function requireDelivery(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    return res.status(401).json({ message: "Delivery login required" });
  }

  try {
    const decoded = jwt.verify(token, DELIVERY_JWT_SECRET);
    req.delivery = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired delivery token" });
  }
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

ensureDir(dataDir);
ensureDir(uploadsDir);
ensureDir(publicDir);
ensureFile(deliveryUsersFile);

app.use("/uploads", express.static(uploadsDir));
app.use(express.static(publicDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeBaseName = path
      .basename(file.originalname || "image", ext)
      .replace(/[^a-zA-Z0-9-_]/g, "-")
      .slice(0, 40);

    cb(null, `${Date.now()}-${safeBaseName || "image"}${ext || ".jpg"}`);
  }
});

function fileFilter(req, file, cb) {
  if (file.mimetype && file.mimetype.startsWith("image/")) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed"));
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }
});

/* FIREBASE HELPERS */
async function readProducts() {
  try {
    const snapshot = await db.collection("products").get();
    return snapshot.docs.map((doc) => {
      const data = doc.data() || {};
      return {
        ...data,
        id: data.id !== undefined ? Number(data.id) : Number(doc.id)
      };
    });
  } catch (error) {
    console.error("Firestore readProducts error:", error);
    return [];
  }
}

async function writeProducts(products) {
  try {
    const batch = db.batch();
    const collectionRef = db.collection("products");
    const existingSnapshot = await collectionRef.get();

    existingSnapshot.docs.forEach((doc) => batch.delete(doc.ref));

    for (const product of products) {
      const ref = collectionRef.doc(String(product.id));
      batch.set(ref, product);
    }

    await batch.commit();
  } catch (error) {
    console.error("Firestore writeProducts error:", error);
  }
}

async function readOrders() {
  try {
    const snapshot = await db.collection("orders").get();
    return snapshot.docs.map((doc) => {
      const data = doc.data() || {};
      return {
        ...data,
        id: data.id || doc.id
      };
    });
  } catch (error) {
    console.error("Firestore readOrders error:", error);
    return [];
  }
}

async function writeOrders(orders) {
  try {
    const batch = db.batch();
    const collectionRef = db.collection("orders");
    const existingSnapshot = await collectionRef.get();

    existingSnapshot.docs.forEach((doc) => batch.delete(doc.ref));

    for (const order of orders) {
      const ref = collectionRef.doc(String(order.id));
      batch.set(ref, order);
    }

    await batch.commit();
  } catch (error) {
    console.error("Firestore writeOrders error:", error);
  }
}

/* HTML ROUTES */
app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(publicDir, "admin.html"));
});

app.get("/delivery", (req, res) => {
  res.sendFile(path.join(publicDir, "delivery.html"));
});

/* CUSTOMER OTP LOGIN */
app.post("/api/customer/request-otp", (req, res) => {
  const phone = normalizePhone(req.body.phone);

  if (!phone || phone.length < 10) {
    return res.status(400).json({ message: "Valid mobile number required" });
  }

  const otp = generateOtp();
  otpStore.set(phone, {
    otp,
    expiresAt: Date.now() + OTP_EXPIRY_MS
  });

  return res.json({
    message: "OTP sent successfully",
    demoOtp: otp,
    expiresInSeconds: 300
  });
});

app.post("/api/customer/verify-otp", (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const otp = String(req.body.otp || "").trim();
  const village = normalizeVillage(req.body.village);

  const saved = otpStore.get(phone);
  if (!saved) {
    return res.status(400).json({ message: "OTP not requested" });
  }

  if (Date.now() > saved.expiresAt) {
    otpStore.delete(phone);
    return res.status(400).json({ message: "OTP expired" });
  }

  if (saved.otp !== otp) {
    return res.status(400).json({ message: "Invalid OTP" });
  }

  const deliveryCharge = getVillageDeliveryCharge(village);
  if (deliveryCharge === null) {
    return res.status(400).json({ message: "Currently not available this address" });
  }

  otpStore.delete(phone);
  const token = createCustomerToken(phone, village);

  return res.json({
    message: "Customer login successful",
    token,
    customer: { phone, village, deliveryCharge }
  });
});

app.get("/api/customer/me", requireCustomer, (req, res) => {
  res.json({
    customer: {
      phone: req.customer.phone,
      village: req.customer.village || ""
    }
  });
});

app.patch("/api/customer/location", requireCustomer, async (req, res) => {
  const phone = normalizePhone(req.customer.phone);
  const nextLocation = sanitizeLocation(req.body);

  if (!nextLocation) {
    return res.status(400).json({ message: "Valid customer location required" });
  }

  const orders = await readOrders();
  let updatedCount = 0;

  for (const order of orders) {
    if (normalizePhone(order.phone) !== phone) continue;
    if (!isOrderLiveTrackable(order)) continue;

    order.customerLocation = {
      latitude: nextLocation.latitude,
      longitude: nextLocation.longitude,
      accuracy: nextLocation.accuracy,
      updatedAt: nextLocation.updatedAt,
      live: true
    };

    updatedCount += 1;
  }

  await writeOrders(orders);

  return res.json({
    message: "Customer live location updated",
    updatedCount
  });
});

/* ADMIN LOGIN */
app.post("/api/admin/login", (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "").trim();

  if (username !== ADMIN_USERNAME.toLowerCase() || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ message: "Invalid username or password" });
  }

  const token = createAdminToken();
  return res.json({
    message: "Login successful",
    token,
    admin: { username: ADMIN_USERNAME }
  });
});

app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ admin: { username: ADMIN_USERNAME } });
});

/* DELIVERY ACCESS REQUEST + LOGIN */
app.post("/api/delivery/request-access", (req, res) => {
  const name = String(req.body.name || "").trim();
  const phone = normalizePhone(req.body.phone);

  if (!name || !phone || phone.length < 10) {
    return res.status(400).json({ message: "Valid name and phone required" });
  }

  const deliveryUsers = readJson(deliveryUsersFile);
  const existing = deliveryUsers.find((user) => normalizePhone(user.phone) === phone);

  if (existing) {
    if (existing.status === "Approved") {
      return res.status(400).json({ message: "This number is already approved. Please login." });
    }
    if (existing.status === "Pending Approval") {
      return res.status(400).json({ message: "Your approval request is already pending." });
    }
    return res.status(400).json({ message: "This number already exists. Contact admin." });
  }

  const newUser = {
    id: "DB" + Date.now(),
    name,
    phone,
    status: "Pending Approval",
    deviceId: "",
    createdAt: getISTDateTime(),
    approvedAt: "",
    updatedAt: getISTDateTime(),
    lastLoginAt: ""
  };

  deliveryUsers.unshift(newUser);
  writeJson(deliveryUsersFile, deliveryUsers);

  return res.status(201).json({
    message: "Request sent to admin for approval",
    deliveryUser: newUser
  });
});

app.post("/api/delivery/login", (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const deviceId = String(req.body.deviceId || "").trim();

  if (!phone || phone.length < 10) {
    return res.status(400).json({ message: "Valid phone required" });
  }

  if (!deviceId) {
    return res.status(400).json({ message: "Device not recognized. Please reopen panel." });
  }

  const deliveryUsers = readJson(deliveryUsersFile);
  const userIndex = deliveryUsers.findIndex((user) => normalizePhone(user.phone) === phone);

  if (userIndex === -1) {
    return res.status(404).json({ message: "No delivery ID found for this number. First request approval." });
  }

  const deliveryUser = deliveryUsers[userIndex];

  if (deliveryUser.status === "Pending Approval") {
    return res.status(403).json({ message: "Your ID is waiting for admin approval." });
  }

  if (deliveryUser.status !== "Approved") {
    return res.status(403).json({ message: "This delivery ID is not active." });
  }

  if (deliveryUser.deviceId && deliveryUser.deviceId !== deviceId) {
    return res.status(403).json({ message: "This ID is already active on another device. Contact admin." });
  }

  if (!deliveryUser.deviceId) {
    deliveryUsers[userIndex].deviceId = deviceId;
  }

  deliveryUsers[userIndex].lastLoginAt = getISTDateTime();
  writeJson(deliveryUsersFile, deliveryUsers);

  const token = createDeliveryToken(deliveryUsers[userIndex]);

  return res.json({
    message: "Delivery login successful",
    token,
    delivery: {
      id: deliveryUsers[userIndex].id,
      name: deliveryUsers[userIndex].name,
      phone: deliveryUsers[userIndex].phone
    }
  });
});

app.get("/api/delivery/me", requireDelivery, (req, res) => {
  const deliveryUsers = readJson(deliveryUsersFile);
  const deliveryUser = deliveryUsers.find((user) => String(user.id) === String(req.delivery.id));

  if (!deliveryUser || deliveryUser.status !== "Approved") {
    return res.status(401).json({ message: "Delivery ID not active" });
  }

  return res.json({
    delivery: {
      id: deliveryUser.id,
      name: deliveryUser.name,
      phone: deliveryUser.phone,
      status: deliveryUser.status
    }
  });
});

/* ADMIN DELIVERY USERS */
app.get("/api/admin/delivery-users", requireAdmin, (req, res) => {
  const deliveryUsers = readJson(deliveryUsersFile);
  res.json(deliveryUsers);
});

app.patch("/api/admin/delivery-users/:id", requireAdmin, (req, res) => {
  const deliveryUsers = readJson(deliveryUsersFile);
  const userId = String(req.params.id);
  const index = deliveryUsers.findIndex((user) => String(user.id) === userId);

  if (index === -1) {
    return res.status(404).json({ message: "Delivery ID not found" });
  }

  const { action, name, phone, resetDevice } = req.body;

  if (name !== undefined) {
    const cleanName = String(name || "").trim();
    if (!cleanName) {
      return res.status(400).json({ message: "Valid name required" });
    }
    deliveryUsers[index].name = cleanName;
  }

  if (phone !== undefined) {
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone || cleanPhone.length < 10) {
      return res.status(400).json({ message: "Valid phone required" });
    }

    const duplicate = deliveryUsers.find(
      (user, i) => i !== index && normalizePhone(user.phone) === cleanPhone
    );

    if (duplicate) {
      return res.status(400).json({ message: "This phone already exists" });
    }

    deliveryUsers[index].phone = cleanPhone;
  }

  if (action === "approve") {
    deliveryUsers[index].status = "Approved";
    deliveryUsers[index].approvedAt = getISTDateTime();
  } else if (action === "reject") {
    deliveryUsers[index].status = "Rejected";
    deliveryUsers[index].deviceId = "";
  }

  if (resetDevice) {
    deliveryUsers[index].deviceId = "";
  }

  deliveryUsers[index].updatedAt = getISTDateTime();
  writeJson(deliveryUsersFile, deliveryUsers);

  res.json({
    message: "Delivery ID updated successfully",
    deliveryUser: deliveryUsers[index]
  });
});

app.delete("/api/admin/delivery-users/:id", requireAdmin, (req, res) => {
  const deliveryUsers = readJson(deliveryUsersFile);
  const userId = String(req.params.id);
  const filtered = deliveryUsers.filter((user) => String(user.id) !== userId);

  if (filtered.length === deliveryUsers.length) {
    return res.status(404).json({ message: "Delivery ID not found" });
  }

  writeJson(deliveryUsersFile, filtered);
  res.json({ message: "Delivery ID deleted successfully" });
});

/* IMAGE UPLOAD */
app.post("/upload", requireAdmin, (req, res) => {
  upload.single("image")(req, res, (error) => {
    if (error) {
      return res.status(400).json({ message: error.message || "Image upload failed" });
    }

    if (!req.file) {
      return res.status(400).json({ message: "No image file uploaded" });
    }

    const imageUrl = `/uploads/${req.file.filename}`;
    return res.status(201).json({ message: "Image uploaded successfully", imageUrl });
  });
});

/* PUBLIC PRODUCTS */
app.get("/api/products", async (req, res) => {
  const products = await readProducts();
  res.json(products);
});

/* ADMIN PRODUCTS */
app.post("/api/products", requireAdmin, async (req, res) => {
  const products = await readProducts();
  const { name, price, original, emoji, image, category, stock, active } = req.body;

  if (!name || !price) {
    return res.status(400).json({ message: "Product name and price are required" });
  }

  const numericPrice = Number(price);
  const numericOriginal = Number(original || price);
  const numericStock = Number(stock || 0);

  if (Number.isNaN(numericPrice) || numericPrice <= 0) {
    return res.status(400).json({ message: "Valid product price is required" });
  }

  const newProduct = {
    id: Date.now(),
    name: String(name).trim(),
    price: numericPrice,
    original: Number.isNaN(numericOriginal) ? numericPrice : numericOriginal,
    emoji: emoji || "🛒",
    image: typeof image === "string" ? image.trim() : "",
    category: category || "Grocery",
    stock: Number.isNaN(numericStock) ? 0 : numericStock,
    active: active !== undefined ? Boolean(active) : numericStock > 0
  };

  products.push(newProduct);
  await writeProducts(products);

  res.status(201).json({ message: "Product added successfully", product: newProduct });
});

app.put("/api/products/:id", requireAdmin, async (req, res) => {
  const products = await readProducts();
  const productId = Number(req.params.id);
  const index = products.findIndex((p) => p.id === productId);

  if (index === -1) {
    return res.status(404).json({ message: "Product not found" });
  }

  const oldProduct = products[index];
  const updatedProduct = { ...oldProduct, ...req.body, id: oldProduct.id };

  if (updatedProduct.name !== undefined) updatedProduct.name = String(updatedProduct.name).trim();
  if (updatedProduct.category !== undefined) updatedProduct.category = String(updatedProduct.category).trim() || "Grocery";
  if (updatedProduct.price !== undefined) updatedProduct.price = Number(updatedProduct.price);
  if (updatedProduct.original !== undefined) updatedProduct.original = Number(updatedProduct.original);
  if (updatedProduct.stock !== undefined) updatedProduct.stock = Number(updatedProduct.stock);
  if (updatedProduct.image !== undefined) updatedProduct.image = typeof updatedProduct.image === "string" ? updatedProduct.image.trim() : "";

  if (!updatedProduct.name) {
    return res.status(400).json({ message: "Product name is required" });
  }

  if (Number.isNaN(updatedProduct.price) || updatedProduct.price <= 0) {
    return res.status(400).json({ message: "Valid product price is required" });
  }

  if (
    updatedProduct.stock !== undefined &&
    (Number.isNaN(updatedProduct.stock) || updatedProduct.stock < 0)
  ) {
    return res.status(400).json({ message: "Valid product stock is required" });
  }

  if (oldProduct.image && updatedProduct.image !== oldProduct.image && updatedProduct.image) {
    deleteImageByUrl(oldProduct.image);
  }

  products[index] = updatedProduct;
  await writeProducts(products);

  res.json({ message: "Product updated successfully", product: updatedProduct });
});

app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  const products = await readProducts();
  const productId = Number(req.params.id);
  const product = products.find((p) => p.id === productId);

  if (!product) {
    return res.status(404).json({ message: "Product not found" });
  }

  const filteredProducts = products.filter((p) => p.id !== productId);
  if (product.image) deleteImageByUrl(product.image);

  await writeProducts(filteredProducts);
  res.json({ message: "Product deleted successfully" });
});

/* CUSTOMER PLACE ORDER */
app.post("/api/orders", requireCustomer, async (req, res) => {
  const phone = normalizePhone(req.customer.phone);
  const village = normalizeVillage(req.customer.village);

  const {
    name,
    address,
    paymentMethod,
    items,
    customerLocation
  } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ message: "Customer name required" });
  }

  if (!address || !String(address).trim()) {
    return res.status(400).json({ message: "Delivery address required" });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "Order items required" });
  }

  const products = await readProducts();
  const orders = await readOrders();

  const finalItems = [];
  let subtotal = 0;

  for (const item of items) {
    const productId = String(item.id || "").trim();
    const qty = Number(item.qty || 0);

    if (!productId || !Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ message: "Invalid item data" });
    }

    const productIndex = products.findIndex((p) => String(p.id) === productId);
    if (productIndex === -1) {
      return res.status(404).json({ message: "One or more products not found" });
    }

    const product = products[productIndex];
    const stock = Number(product.stock || 0);

    if (qty > stock) {
      return res.status(400).json({
        message: `${product.name || "Product"} is out of stock or insufficient quantity`
      });
    }

    const price = Number(product.price || 0);
    const originalPrice = Number(product.originalPrice || product.original || price || 0);

    finalItems.push({
      id: product.id,
      name: product.name || "",
      price,
      originalPrice,
      qty,
      image: product.image || "",
      category: product.category || ""
    });

    subtotal += price * qty;
  }

  const shipping = Number(getVillageDeliveryCharge(village) || 0);
  const total = subtotal + shipping;
  const cleanPaymentMethod =
    String(paymentMethod || "cod").trim().toLowerCase() === "upi" ? "UPI" : "COD";

  const cleanCustomerLocation = sanitizeLocation(customerLocation);

  const newOrder = {
    id: generateOrderId(),
    name: String(name || "").trim(),
    phone,
    village,
    address: String(address || "").trim(),
    paymentMethod: cleanPaymentMethod,
    paymentStatus: cleanPaymentMethod === "UPI" ? "Payment Pending" : "COD",
    items: finalItems,
    subtotal,
    shipping,
    total,
    status: "Need Confirmation",
    assignedDeliveryBoyId: "",
    assignedDeliveryBoyName: "",
    assignedDeliveryBoyPhone: "",
    deliveryBoyId: "",
    deliveryBoyName: "",
    deliveryBoyPhone: "",
    deliveryStartedAt: "",
    deliveredAt: "",
    customerLocation: cleanCustomerLocation || clearLiveLocation(),
    date: getISTDateTime()
  };

  for (const item of finalItems) {
    const productIndex = products.findIndex((p) => String(p.id) === String(item.id));
    if (productIndex !== -1) {
      products[productIndex].stock = Math.max(
        0,
        Number(products[productIndex].stock || 0) - Number(item.qty || 0)
      );
    }
  }

  orders.unshift(newOrder);
  await writeProducts(products);
  await writeOrders(orders);

  return res.status(201).json({
    message: "Order placed successfully",
    order: normalizeOrderForResponse(newOrder)
  });
});

/* CUSTOMER OWN ORDERS */
app.get("/api/my-orders", requireCustomer, async (req, res) => {
  const phone = normalizePhone(req.customer.phone);
  const orders = await readOrders();

  const customerOrders = orders
    .filter((order) => normalizePhone(order.phone) === phone)
    .map(normalizeOrderForResponse);

  return res.json(customerOrders);
});

/* ADMIN ORDERS */
app.get("/api/orders", requireAdmin, async (req, res) => {
  const orders = (await readOrders()).map(normalizeOrderForResponse);
  return res.json(orders);
});

/* ADMIN CONFIRM / STATUS */
app.patch("/api/admin/orders/:id/status", requireAdmin, async (req, res) => {
  const orders = await readOrders();
  const orderId = req.params.id;
  const { status, paymentStatus } = req.body;

  const index = orders.findIndex((o) => o.id === orderId);
  if (index === -1) {
    return res.status(404).json({ message: "Order not found" });
  }

  if (status) {
    const validStatuses = ["Need Confirmation", "Pending"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    orders[index].status = status;
  }

  if (paymentStatus) {
    const validPaymentStatuses = ["COD", "Payment Pending", "Payment Confirmed"];
    if (!validPaymentStatuses.includes(paymentStatus)) {
      return res.status(400).json({ message: "Invalid payment status" });
    }
    orders[index].paymentStatus = paymentStatus;
  }

  await writeOrders(orders);
  res.json({ message: "Order updated successfully", order: orders[index] });
});

/* ADMIN ASSIGN DELIVERY BOY */
app.patch("/api/admin/orders/:id/assign-delivery", requireAdmin, async (req, res) => {
  const orders = await readOrders();
  const deliveryUsers = readJson(deliveryUsersFile);

  const orderId = String(req.params.id || "").trim();
  const deliveryBoyId = String(req.body.deliveryBoyId || "").trim();

  console.log("ASSIGN ROUTE HIT");
  console.log("orderId:", orderId);
  console.log("deliveryBoyId:", deliveryBoyId);
  console.log("deliveryUsers:", deliveryUsers);

  if (!deliveryBoyId) {
    return res.status(400).json({ message: "Delivery boy ID required" });
  }

  const orderIndex = orders.findIndex((o) => String(o.id || "").trim() === orderId);
  if (orderIndex === -1) {
    return res.status(404).json({ message: "Order not found" });
  }

  const deliveryBoy = deliveryUsers.find(
    (d) => String(d.id || "").trim() === deliveryBoyId
  );

  if (!deliveryBoy) {
    return res.status(400).json({ message: "Delivery boy ID not found" });
  }

  if (String(deliveryBoy.status || "").trim().toLowerCase() !== "approved") {
    return res.status(400).json({
      message: `Delivery boy not approved. Current status: ${deliveryBoy.status || "Unknown"}`
    });
  }

  orders[orderIndex].assignedDeliveryBoyId = deliveryBoy.id;
  orders[orderIndex].assignedDeliveryBoyName = deliveryBoy.name;
  orders[orderIndex].assignedDeliveryBoyPhone = deliveryBoy.phone;

  orders[orderIndex].deliveryBoyId = deliveryBoy.id;
  orders[orderIndex].deliveryBoyName = deliveryBoy.name;
  orders[orderIndex].deliveryBoyPhone = deliveryBoy.phone;

  await writeOrders(orders);

  return res.json({
    message: "Delivery boy assigned successfully",
    order: orders[orderIndex]
  });
});

/* DELIVERY ORDERS: ONLY ASSIGNED */
app.get("/api/delivery/orders", requireDelivery, async (req, res) => {
  const orders = await readOrders();

  const deliveryOrders = orders
    .filter((order) => {
      const assignedId = String(order.assignedDeliveryBoyId || order.deliveryBoyId || "").trim();
      return assignedId === String(req.delivery.id || "").trim();
    })
    .map(normalizeOrderForResponse);

  return res.json(deliveryOrders);
});

app.patch("/api/delivery/orders/:id/status", requireDelivery, async (req, res) => {
  const orderId = String(req.params.id || "").trim();
  const status = String(req.body.status || "").trim();

  const allowedStatuses = ["Pending", "Out for Delivery", "Delivered"];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ message: "Invalid order status" });
  }

  const orders = await readOrders();
  const index = orders.findIndex((order) => String(order.id) === orderId);

  if (index === -1) {
    return res.status(404).json({ message: "Order not found" });
  }

  const assignedId = String(
    orders[index].assignedDeliveryBoyId || orders[index].deliveryBoyId || ""
  ).trim();

  if (assignedId !== String(req.delivery.id || "").trim()) {
    return res.status(403).json({ message: "This order is not assigned to you" });
  }

  orders[index].status = status;
  orders[index].deliveryBoyId = req.delivery.id || orders[index].deliveryBoyId || "";
  orders[index].deliveryBoyName = req.delivery.name || orders[index].deliveryBoyName || "";
  orders[index].deliveryBoyPhone = req.delivery.phone || orders[index].deliveryBoyPhone || "";

  if (status === "Out for Delivery") {
    orders[index].deliveryStartedAt = getISTDateTime();

    if (
      orders[index].customerLocation &&
      orders[index].customerLocation.latitude !== ""
    ) {
      orders[index].customerLocation.live = true;
      orders[index].customerLocation.updatedAt = getISTDateTime();
    }
  }

  if (status === "Delivered") {
    orders[index].deliveredAt = getISTDateTime();
    orders[index].customerLocation = clearLiveLocation();
  }

  await writeOrders(orders);

  return res.json({
    message: "Order status updated successfully",
    order: normalizeOrderForResponse(orders[index])
  });
});

/* OLD COMPAT PAYMENT ROUTE */
app.put("/api/orders/:id/payment-status", requireAdmin, async (req, res) => {
  const orders = await readOrders();
  const orderId = req.params.id;
  const { paymentStatus } = req.body;

  const validPaymentStatuses = ["COD", "Payment Pending", "Payment Confirmed"];
  const index = orders.findIndex((o) => o.id === orderId);

  if (index === -1) {
    return res.status(404).json({ message: "Order not found" });
  }

  if (!paymentStatus || !validPaymentStatuses.includes(paymentStatus)) {
    return res.status(400).json({ message: "Invalid payment status" });
  }

  orders[index].paymentStatus = paymentStatus;
  await writeOrders(orders);

  res.json({
    message: "Payment status updated successfully",
    order: orders[index]
  });
});

/* DELETE ORDER */
app.delete("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  const orders = await readOrders();
  const orderId = req.params.id;
  const filteredOrders = orders.filter((o) => o.id !== orderId);

  if (filteredOrders.length === orders.length) {
    return res.status(404).json({ message: "Order not found" });
  }

  await writeOrders(filteredOrders);
  res.json({ message: "Order deleted successfully" });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});