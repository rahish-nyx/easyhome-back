const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const http = require("http");
const { Server } = require("socket.io");
const geolib = require("geolib");
const nodemailer = require("nodemailer");
const dns = require("dns");

dns.setDefaultResultOrder("ipv4first");

const app = express();
console.log("MONGODB_URI:", process.env.MONGODB_URI);
const server = http.createServer(app);
const JWT_SECRET = process.env.JWT_SECRET || "easyhomes_secret_key";

const allowedOrigins = [
  "https://easyhome-front.vercel.app",
  "https://easyhomeservice.netlify.app",
  "http://localhost:5173",
  "http://localhost:3000",
];

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS blocked: ${origin}`));
    }
  },
  credentials: true,
};

const io = new Server(server, { cors: corsOptions });

app.use(cors(corsOptions));
app.use(express.json());
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
app.use("/uploads", express.static("uploads"));

mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log("MongoDB Atlas Connected");
    await createDefaultAdmin();
    await seedServices();
  })
  .catch((err) => console.log("DB Error:", err));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) =>
    cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  family: 4,
  connectionTimeout: 30000,
  greetingTimeout: 30000,
  socketTimeout: 30000,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  tls: { rejectUnauthorized: false },
});
transporter.verify((error) => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log("Email config error: EMAIL_USER or EMAIL_PASS missing");
  } else if (error) console.log("Email config error:", error.message);
  else console.log("Email server ready");
});

const otpStore = {};
let adminSubscriptionUPI = process.env.ADMIN_UPI || "admin@easyhome.upi";

// ================= SCHEMAS =================

const customerSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  phone: String,
  emailVerified: { type: Boolean, default: false },
  adminRating: { type: Number, default: 0 },
  adminBadge: { type: String, default: "" },
  adminNote: { type: String, default: "" },
  isSubscribed: { type: Boolean, default: false },
  subscriptionEnd: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

const workerSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  phone: String,
  service: String,
  location: String,
  pricePerHour: Number, // kept for DB compat — used as pricePerWork
  rating: { type: Number, default: 0 },
  jobs: { type: Number, default: 0 },
  isUrgent: { type: Boolean, default: false },
  upiId: { type: String, default: "" },
  lat: { type: Number, default: null },
  lng: { type: Number, default: null },
  approved: { type: Boolean, default: false },
  adminRating: { type: Number, default: 0 },
  adminBadge: { type: String, default: "" },
  adminNote: { type: String, default: "" },
  isSubscribed: { type: Boolean, default: false },
  subscriptionEnd: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

const bookingSchema = new mongoose.Schema({
  description: String,
  service: String,
  location: String,
  phone: String,
  image: String,
  pricePerHour: Number,
  urgency: String,
  finalPrice: Number,
  status: { type: String, default: "pending" },
  worker: { type: String, default: null },
  workerId: { type: String, default: null },
  customerId: String,
  paymentMode: { type: String, default: null },
  paymentDone: { type: Boolean, default: false },
  lat: { type: Number, default: null },
  lng: { type: Number, default: null },
  removedByAdmin: { type: Boolean, default: false },
  finalPriceConfirmed: { type: Boolean, default: false },
  workerSetPrice: { type: Number, default: null },
  customerSetPrice: { type: Number, default: null },
  confirmedPrice: { type: Number, default: null },
  commission: { type: Number, default: 0 },
  workerReceives: { type: Number, default: null },
  createdAt: { type: Date, default: Date.now },
});

const urgentSchema = new mongoose.Schema({
  title: String,
  price: String,
  location: String,
  createdAt: { type: Date, default: Date.now },
});
const notificationSchema = new mongoose.Schema({
  workerId: String,
  bookingId: String,
  service: String,
  description: String,
  location: String,
  finalPrice: Number,
  urgency: String,
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

// ✅ UPDATED citySchema — now includes serviceRadius for geofencing
const citySchema = new mongoose.Schema({
  name: String,
  lat: Number,
  lng: Number,
  serviceRadius: { type: Number, default: 10000 }, // radius in meters (default 10km)
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

const adminSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  password: String,
  createdAt: { type: Date, default: Date.now },
});
const chatSchema = new mongoose.Schema({
  senderId: String,
  senderName: String,
  senderRole: String,
  receiverId: String,
  receiverRole: String,
  message: String,
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});
const ratingSchema = new mongoose.Schema({
  workerId: String,
  workerName: String,
  customerId: String,
  customerName: String,
  bookingId: String,
  stars: { type: Number, min: 1, max: 5 },
  createdAt: { type: Date, default: Date.now },
});
const serviceSchema = new mongoose.Schema({
  name: String,
  icon: String,
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});
const adminRatingSchema = new mongoose.Schema({
  targetId: String,
  targetName: String,
  targetRole: String,
  stars: { type: Number, min: 1, max: 5 },
  badge: { type: String, default: "" },
  note: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
});
const subscriptionSchema = new mongoose.Schema({
  userId: String,
  userRole: String,
  userName: String,
  userEmail: String,
  price: { type: Number, default: 199 },
  status: { type: String, default: "pending" },
  screenshotNote: { type: String, default: "" },
  startDate: { type: Date, default: null },
  endDate: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
const commissionSchema = new mongoose.Schema({
  workerId: String,
  workerName: String,
  bookingId: String,
  amount: { type: Number, default: 0 },
  status: { type: String, default: "pending" },
  screenshotNote: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
});
const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed,
});

const Customer = mongoose.model("Customer", customerSchema);
const Worker = mongoose.model("Worker", workerSchema);
const Booking = mongoose.model("Booking", bookingSchema);
const Urgent = mongoose.model("Urgent", urgentSchema);
const Notification = mongoose.model("Notification", notificationSchema);
const City = mongoose.model("City", citySchema);
const Admin = mongoose.model("Admin", adminSchema);
const Chat = mongoose.model("Chat", chatSchema);
const Rating = mongoose.model("Rating", ratingSchema);
const Service = mongoose.model("Service", serviceSchema);
const AdminRating = mongoose.model("AdminRating", adminRatingSchema);
const Subscription = mongoose.model("Subscription", subscriptionSchema);
const Commission = mongoose.model("Commission", commissionSchema);
const Settings = mongoose.model("Settings", settingsSchema);

// ================= MIDDLEWARE =================
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== "admin")
      return res.status(403).json({ error: "Not admin" });
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ================= SOCKET.IO =================
const workerSockets = {},
  customerSockets = {};
io.on("connection", (socket) => {
  socket.on("register_worker", (id) => {
    workerSockets[id] = socket.id;
  });
  socket.on("register_customer", (id) => {
    customerSockets[id] = socket.id;
  });
  socket.on("disconnect", () => {
    for (const [k, v] of Object.entries(workerSockets)) {
      if (v === socket.id) {
        delete workerSockets[k];
        break;
      }
    }
    for (const [k, v] of Object.entries(customerSockets)) {
      if (v === socket.id) {
        delete customerSockets[k];
        break;
      }
    }
  });
});

// ================= DEFAULT DATA =================
async function createDefaultAdmin() {
  try {
    const exists = await Admin.findOne({ email: "nooreply@easyhome.com" });
    if (!exists) {
      const hashed = await bcrypt.hash("void@void053", 10);
      await Admin.create({ email: "nooreply@easyhome.com", password: hashed });
      console.log("Default admin created");
    }
  } catch (err) {
    console.log("Admin init error:", err);
  }
}
async function seedServices() {
  const count = await Service.countDocuments();
  if (count === 0) {
    await Service.insertMany([
      { name: "Plumber", icon: "🔧" },
      { name: "Electrician", icon: "⚡" },
      { name: "Tutor", icon: "📚" },
      { name: "Cleaner", icon: "🧹" },
      { name: "AC Repair", icon: "❄️" },
      { name: "Carpenter", icon: "🔨" },
    ]);
    console.log("Default services seeded");
  }
}

// ================= SETTINGS HELPERS =================
async function getSetting(key, defaultValue) {
  const s = await Settings.findOne({ key });
  return s ? s.value : defaultValue;
}
async function setSetting(key, value) {
  await Settings.findOneAndUpdate(
    { key },
    { value },
    { upsert: true, new: true },
  );
}

// ================= OTP =================
async function sendOtpEmail(email, otp) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    throw new Error("EMAIL_USER or EMAIL_PASS missing");
  }

  const info = await transporter.sendMail({
    from: `"EasyHome" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "Your EasyHome OTP",
    html: `<div style="font-family:Arial;max-width:400px;margin:0 auto;padding:20px;border-radius:12px;border:1px solid #eee;"><h2 style="color:#ff3c00;">EasyHome</h2><p>Your OTP is:</p><div style="background:#fff8f0;border:2px solid #ff7a18;border-radius:10px;padding:16px;text-align:center;"><h1 style="color:#ff3c00;letter-spacing:8px;margin:0;">${otp}</h1></div><p style="color:#888;font-size:13px;margin-top:12px;">Valid for 5 minutes. Do not share.</p></div>`,
  });

  console.log("OTP email sent:", info.messageId, "to", email);
  return info;
}

// ================= AUTH ROUTES =================
app.post("/customer/send-otp", async (req, res) => {
  try {
    const { email, forRegister } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });
    if (!forRegister) {
      const customer = await Customer.findOne({ email });
      if (!customer)
        return res.status(400).json({ error: "Email not registered" });
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await sendOtpEmail(email, otp);
    otpStore[email] = { otp, expires: Date.now() + 5 * 60 * 1000 };
    res.json({ message: "OTP sent" });
  } catch (err) {
    console.log("OTP Error:", err?.message || err);
    res.status(500).json({ error: "Failed to send OTP." });
  }
});

app.post("/customer/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    const stored = otpStore[email];
    if (!stored)
      return res.status(400).json({ error: "OTP not sent or expired" });
    if (Date.now() > stored.expires) {
      delete otpStore[email];
      return res.status(400).json({ error: "OTP expired" });
    }
    if (stored.otp !== otp) return res.status(400).json({ error: "Wrong OTP" });
    delete otpStore[email];
    res.json({ verified: true });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/customer/register", async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password || !phone)
      return res.status(400).json({ error: "All fields required" });
    if (await Customer.findOne({ email }))
      return res.status(400).json({ error: "Email already registered" });
    const hashed = await bcrypt.hash(password, 10);
    const customer = await Customer.create({
      name,
      email,
      password: hashed,
      phone,
      emailVerified: true,
    });
    const token = jwt.sign(
      { id: customer._id, role: "customer", name: customer.name },
      JWT_SECRET,
      { expiresIn: "7d" },
    );
    res.json({
      token,
      role: "customer",
      name: customer.name,
      id: customer._id,
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/customer/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const customer = await Customer.findOne({ email });
    if (!customer) return res.status(400).json({ error: "Email not found" });
    if (!(await bcrypt.compare(password, customer.password)))
      return res.status(400).json({ error: "Wrong password" });
    const token = jwt.sign(
      { id: customer._id, role: "customer", name: customer.name },
      JWT_SECRET,
      { expiresIn: "7d" },
    );
    res.json({
      token,
      role: "customer",
      name: customer.name,
      id: customer._id,
    });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/worker/register", async (req, res) => {
  try {
    const { name, email, password, phone, service, location, pricePerHour } =
      req.body;
    if (!name || !email || !password || !phone || !service)
      return res.status(400).json({ error: "All fields required" });
    if (await Worker.findOne({ email }))
      return res.status(400).json({ error: "Email already registered" });
    const hashed = await bcrypt.hash(password, 10);
    const price = Math.max(200, Number(pricePerHour) || 200); // ✅ min 200
    await Worker.create({
      name,
      email,
      password: hashed,
      phone,
      service,
      location,
      pricePerHour: price,
      approved: false,
    });
    res.json({
      pending: true,
      message: "Registration submitted! Admin will review your account.",
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/worker/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const worker = await Worker.findOne({ email });
    if (!worker) return res.status(400).json({ error: "Email not found" });
    if (!(await bcrypt.compare(password, worker.password)))
      return res.status(400).json({ error: "Wrong password" });
    if (!worker.approved)
      return res
        .status(403)
        .json({
          error: "Account pending approval. Check your email.",
          pending: true,
        });
    const token = jwt.sign(
      { id: worker._id, role: "worker", name: worker.name },
      JWT_SECRET,
      { expiresIn: "7d" },
    );
    res.json({ token, role: "worker", name: worker.name, id: worker._id });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const admin = await Admin.findOne({ email });
    if (!admin) return res.status(400).json({ error: "Admin not found" });
    if (!(await bcrypt.compare(password, admin.password)))
      return res.status(400).json({ error: "Wrong password" });
    const token = jwt.sign({ id: admin._id, role: "admin" }, JWT_SECRET, {
      expiresIn: "7d",
    });
    res.json({ token, role: "admin" });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// ================= ADMIN MANAGER ROUTES =================
app.get("/admin/admins", adminMiddleware, async (req, res) => {
  try {
    res.json(await Admin.find({}, "-password").sort({ createdAt: 1 }));
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.post("/admin/add-admin", adminMiddleware, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password required" });
    if (password.length < 8)
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters" });
    if (await Admin.findOne({ email }))
      return res
        .status(400)
        .json({ error: "Admin with this email already exists" });
    const hashed = await bcrypt.hash(password, 10);
    const newAdmin = await Admin.create({ email, password: hashed });
    res.json({
      message: "Admin added",
      id: newAdmin._id,
      email: newAdmin.email,
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Failed to add admin" });
  }
});
app.delete("/admin/remove-admin/:id", adminMiddleware, async (req, res) => {
  try {
    const count = await Admin.countDocuments();
    if (count <= 1)
      return res
        .status(400)
        .json({ error: "Cannot delete the only admin account" });
    if (req.params.id === req.user.id)
      return res
        .status(400)
        .json({ error: "Cannot delete your own account while logged in" });
    await Admin.findByIdAndDelete(req.params.id);
    res.json({ message: "Admin removed" });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// ================= GEOFENCE HELPERS =================
function cleanCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function radiusToMeters(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 10000;
  return number <= 500 ? number * 1000 : number;
}

async function findServiceArea(lat, lng) {
  const userLat = cleanCoordinate(lat);
  const userLng = cleanCoordinate(lng);
  if (userLat === null || userLng === null) {
    return { error: "Valid location required" };
  }

  const cities = await City.find({ active: true });
  if (cities.length === 0) return { allowed: true, city: null };

  let nearest = null;

  for (const city of cities) {
    const cityLat = cleanCoordinate(city.lat);
    const cityLng = cleanCoordinate(city.lng);
    if (cityLat === null || cityLng === null) continue;

    const serviceRadius = radiusToMeters(city.serviceRadius);
    const distance = geolib.getDistance(
      { latitude: userLat, longitude: userLng },
      { latitude: cityLat, longitude: cityLng },
    );

    if (!nearest || distance < nearest.distance) {
      nearest = { city, distance, serviceRadius };
    }

    if (distance <= serviceRadius) {
      return { allowed: true, city, distance, serviceRadius };
    }
  }

  return { allowed: false, nearest };
}

// ================= GEOFENCE MIDDLEWARE =================
async function enforceServiceArea(req, res, next) {
  try {
    const lat = req.body.lat || req.query.lat;
    const lng = req.body.lng || req.query.lng;

    const area = await findServiceArea(lat, lng);
    if (area.error) return res.status(400).json({ error: area.error });
    if (!area.allowed)
      return res.status(403).json({
        error: "Service is not available in this area yet.",
      });

    req.serviceArea = area;
    next();
  } catch (err) {
    console.log("Geofence error:", err);
    res.status(500).json({ error: "Geofence check failed" });
  }
}

app.post("/check-service-area", async (req, res) => {
  try {
    const area = await findServiceArea(req.body.lat, req.body.lng);
    if (area.error)
      return res.status(400).json({ allowed: false, message: area.error });

    if (!area.allowed) {
      return res.json({
        allowed: false,
        message: "EasyHome is not available in your area yet.",
        nearestCity: area.nearest?.city?.name || null,
        distanceMeters: area.nearest?.distance || null,
        serviceRadiusMeters: area.nearest?.serviceRadius || null,
      });
    }

    res.json({
      allowed: true,
      city: area.city?.name || "Your Area",
      distanceMeters: area.distance || 0,
      serviceRadiusMeters: area.serviceRadius || null,
    });
  } catch (err) {
    console.log("Service area check error:", err);
    res.status(500).json({
      allowed: false,
      message: "Service area check failed",
    });
  }
});

// ================= CITY ROUTES =================
app.get("/admin/cities", adminMiddleware, async (req, res) => {
  try {
    res.json(await City.find().sort({ name: 1 }));
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// ✅ UPDATED — now accepts serviceRadius
app.post("/admin/city", adminMiddleware, async (req, res) => {
  try {
    const { name, lat, lng, serviceRadius } = req.body;
    if (!name || !lat || !lng)
      return res.status(400).json({ error: "Name, lat, lng required" });
    if (await City.findOne({ name }))
      return res.status(400).json({ error: "City already exists" });
    res.json(
      await City.create({
        name,
        lat,
        lng,
        serviceRadius: radiusToMeters(serviceRadius),
      }),
    );
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// ✅ UPDATED — now can update serviceRadius too
app.put("/admin/city/:id", adminMiddleware, async (req, res) => {
  try {
    const city = await City.findById(req.params.id);
    if (!city) return res.status(404).json({ error: "Not found" });
    // If body has serviceRadius, update it; otherwise toggle active
    if (req.body.serviceRadius !== undefined) {
      city.serviceRadius = radiusToMeters(req.body.serviceRadius);
      await city.save();
    } else {
      city.active = !city.active;
      await city.save();
    }
    res.json(city);
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

app.delete("/admin/city/:id", adminMiddleware, async (req, res) => {
  try {
    await City.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted" });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// ================= ADMIN ROUTES =================
app.get("/admin/users", adminMiddleware, async (req, res) => {
  try {
    const customers = await Customer.find({}, "-password");
    const workers = await Worker.find({ approved: true }, "-password");
    res.json({ customers, workers });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.delete("/admin/user/:role/:id", adminMiddleware, async (req, res) => {
  try {
    const { role, id } = req.params;
    if (role === "customer") await Customer.findByIdAndDelete(id);
    else if (role === "worker") await Worker.findByIdAndDelete(id);
    res.json({ message: "Account deleted" });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.get("/admin/bookings", adminMiddleware, async (req, res) => {
  try {
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    res.json(
      await Booking.find({
        removedByAdmin: { $ne: true },
        createdAt: { $gte: oneMonthAgo },
      }).sort({ _id: -1 }),
    );
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.delete("/admin/booking/:id", adminMiddleware, async (req, res) => {
  try {
    await Booking.findByIdAndUpdate(req.params.id, { removedByAdmin: true });
    res.json({ message: "Job removed" });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.get("/admin/pending-workers", adminMiddleware, async (req, res) => {
  try {
    res.json(await Worker.find({ approved: false }, "-password"));
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.put("/admin/worker/approve/:id", adminMiddleware, async (req, res) => {
  try {
    const worker = await Worker.findByIdAndUpdate(
      req.params.id,
      { approved: true },
      { new: true },
    );
    try {
      await transporter.sendMail({
        from: `"EasyHome" <${process.env.EMAIL_USER}>`,
        to: worker.email,
        subject: "EasyHome Worker Account Approved!",
        html: `<div style="font-family:Arial;padding:20px;"><h2 style="color:#ff3c00;">EasyHome</h2><p>Hi <strong>${worker.name}</strong>, your account has been approved!</p></div>`,
      });
    } catch (e) {
      console.log("Email failed:", e.message);
    }
    res.json({ message: "Worker approved" });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.put("/admin/worker/reject/:id", adminMiddleware, async (req, res) => {
  try {
    const { reason } = req.body;
    const worker = await Worker.findById(req.params.id);
    try {
      await transporter.sendMail({
        from: `"EasyHome" <${process.env.EMAIL_USER}>`,
        to: worker.email,
        subject: "EasyHome Worker Application Update",
        html: `<div style="font-family:Arial;padding:20px;"><h2 style="color:#ff3c00;">EasyHome</h2><p>Hi <strong>${worker.name}</strong>, your application was not approved.${reason ? ` Reason: ${reason}` : ""}</p></div>`,
      });
    } catch (e) {
      console.log("Email failed:", e.message);
    }
    await Worker.findByIdAndDelete(req.params.id);
    res.json({ message: "Worker rejected" });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.put("/admin/worker/urgent/:id", adminMiddleware, async (req, res) => {
  try {
    const worker = await Worker.findById(req.params.id);
    if (!worker) return res.status(404).json({ error: "Not found" });
    worker.isUrgent = !worker.isUrgent;
    await worker.save();
    res.json({ message: "Done", isUrgent: worker.isUrgent });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.post("/admin/rate", adminMiddleware, async (req, res) => {
  try {
    const { targetId, targetName, targetRole, stars, badge, note } = req.body;
    await AdminRating.deleteMany({ targetId });
    const rating = await AdminRating.create({
      targetId,
      targetName,
      targetRole,
      stars,
      badge,
      note,
    });
    if (targetRole === "worker")
      await Worker.findByIdAndUpdate(targetId, {
        adminRating: stars,
        adminBadge: badge,
        adminNote: note,
      });
    else
      await Customer.findByIdAndUpdate(targetId, {
        adminRating: stars,
        adminBadge: badge,
        adminNote: note,
      });
    res.json(rating);
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.get("/admin/ratings", adminMiddleware, async (req, res) => {
  try {
    res.json(await AdminRating.find().sort({ createdAt: -1 }));
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.get("/admin/services", adminMiddleware, async (req, res) => {
  try {
    res.json(await Service.find().sort({ createdAt: 1 }));
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.post("/admin/service", adminMiddleware, async (req, res) => {
  try {
    const { name, icon } = req.body;
    if (!name || !icon)
      return res.status(400).json({ error: "Name and icon required" });
    if (await Service.findOne({ name }))
      return res.status(400).json({ error: "Service already exists" });
    res.json(await Service.create({ name, icon }));
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.put("/admin/service/:id", adminMiddleware, async (req, res) => {
  try {
    res.json(
      await Service.findByIdAndUpdate(req.params.id, req.body, { new: true }),
    );
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.delete("/admin/service/:id", adminMiddleware, async (req, res) => {
  try {
    await Service.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted" });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.get("/admin/stats", adminMiddleware, async (req, res) => {
  try {
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    const totalBookings = await Booking.countDocuments({
      createdAt: { $gte: oneMonthAgo },
    });
    const totalCustomers = await Customer.countDocuments();
    const totalWorkers = await Worker.countDocuments({ approved: true });
    const revenue = await Booking.aggregate([
      { $match: { paymentDone: true, createdAt: { $gte: oneMonthAgo } } },
      { $group: { _id: null, total: { $sum: "$finalPrice" } } },
    ]);
    res.json({
      totalBookings,
      totalCustomers,
      totalWorkers,
      revenue: revenue[0]?.total || 0,
    });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// ================= SUBSCRIPTION ROUTES =================
app.get("/subscription/upi", async (req, res) => {
  try {
    res.json({ upi: await getSetting("adminUpi", adminSubscriptionUPI) });
  } catch {
    res.json({ upi: adminSubscriptionUPI });
  }
});
app.get("/subscription/my", authMiddleware, async (req, res) => {
  try {
    res.json(
      (await Subscription.findOne({ userId: req.user.id }).sort({
        createdAt: -1,
      })) || null,
    );
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.post("/subscription/request", authMiddleware, async (req, res) => {
  try {
    const { screenshotNote } = req.body;
    const existing = await Subscription.findOne({
      userId: req.user.id,
      status: { $in: ["pending", "active"] },
    });
    if (existing)
      return res
        .status(400)
        .json({
          error:
            existing.status === "active"
              ? "Already subscribed"
              : "Request already pending",
        });
    const Model = req.user.role === "worker" ? Worker : Customer;
    const user = await Model.findById(req.user.id);
    const price = await getSetting("subscriptionPrice", 199);
    const sub = await Subscription.create({
      userId: req.user.id,
      userRole: req.user.role,
      userName: user.name,
      userEmail: user.email,
      screenshotNote: screenshotNote || "",
      price,
    });
    res.json(sub);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Failed" });
  }
});
app.get("/admin/subscriptions", adminMiddleware, async (req, res) => {
  try {
    res.json(await Subscription.find().sort({ createdAt: -1 }));
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.put(
  "/admin/subscription/approve/:id",
  adminMiddleware,
  async (req, res) => {
    try {
      const start = new Date();
      const end = new Date();
      end.setMonth(end.getMonth() + 1);
      const sub = await Subscription.findByIdAndUpdate(
        req.params.id,
        { status: "active", startDate: start, endDate: end },
        { new: true },
      );
      const Model = sub.userRole === "worker" ? Worker : Customer;
      await Model.findByIdAndUpdate(sub.userId, {
        isSubscribed: true,
        subscriptionEnd: end,
        ...(sub.userRole === "worker" ? { isUrgent: true } : {}),
      });
      try {
        await transporter.sendMail({
          from: `"EasyHome" <${process.env.EMAIL_USER}>`,
          to: sub.userEmail,
          subject: "EasyHome Premium Activated!",
          html: `<div style="font-family:Arial;padding:20px;"><h2 style="color:#ff3c00;">EasyHome Premium</h2><p>Hi <strong>${sub.userName}</strong>, your subscription is active until <strong>${end.toDateString()}</strong>!</p></div>`,
        });
      } catch (e) {
        console.log("Email error:", e.message);
      }
      res.json({ message: "Approved" });
    } catch {
      res.status(500).json({ error: "Failed" });
    }
  },
);
app.put("/admin/subscription/reject/:id", adminMiddleware, async (req, res) => {
  try {
    const sub = await Subscription.findByIdAndUpdate(
      req.params.id,
      { status: "rejected" },
      { new: true },
    );
    try {
      await transporter.sendMail({
        from: `"EasyHome" <${process.env.EMAIL_USER}>`,
        to: sub.userEmail,
        subject: "EasyHome Subscription Update",
        html: `<div style="font-family:Arial;padding:20px;"><h2 style="color:#ff3c00;">EasyHome</h2><p>Hi ${sub.userName}, your payment could not be verified. Please try again.</p></div>`,
      });
    } catch (e) {
      console.log("Email error:", e.message);
    }
    res.json({ message: "Rejected" });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.put("/admin/subscription/upi", adminMiddleware, async (req, res) => {
  try {
    const { upi } = req.body;
    if (!upi) return res.status(400).json({ error: "UPI required" });
    adminSubscriptionUPI = upi;
    await setSetting("adminUpi", upi);
    res.json({ message: "Updated", upi });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// ================= SETTINGS ROUTES =================
app.get("/settings", async (req, res) => {
  try {
    res.json({
      subscriptionPrice: await getSetting("subscriptionPrice", 199),
      subscriptionBenefitsCustomer: await getSetting(
        "subscriptionBenefitsCustomer",
        [
          "Up to 3 days free service check by our expert workers",
          "Fast acceptance of your booked services",
          "Priority support from EasyHome team",
          "Premium badge on your profile",
        ],
      ),
      subscriptionBenefitsWorker: await getSetting(
        "subscriptionBenefitsWorker",
        [
          "No 10% commission deducted on completed jobs",
          "Listed first — high visibility to customers",
          "Auto-listed in Urgent (Need Now) for full month",
          "Premium badge shown on your worker card",
        ],
      ),
      qrCodeUrl: await getSetting("qrCodeUrl", ""),
      adminUpi: await getSetting("adminUpi", adminSubscriptionUPI),
    });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.put(
  "/admin/settings",
  adminMiddleware,
  upload.single("qrCode"),
  async (req, res) => {
    try {
      const {
        subscriptionPrice,
        subscriptionBenefitsCustomer,
        subscriptionBenefitsWorker,
        adminUpi,
      } = req.body;
      if (subscriptionPrice)
        await setSetting("subscriptionPrice", Number(subscriptionPrice));
      if (subscriptionBenefitsCustomer)
        await setSetting(
          "subscriptionBenefitsCustomer",
          typeof subscriptionBenefitsCustomer === "string"
            ? JSON.parse(subscriptionBenefitsCustomer)
            : subscriptionBenefitsCustomer,
        );
      if (subscriptionBenefitsWorker)
        await setSetting(
          "subscriptionBenefitsWorker",
          typeof subscriptionBenefitsWorker === "string"
            ? JSON.parse(subscriptionBenefitsWorker)
            : subscriptionBenefitsWorker,
        );
      if (adminUpi) {
        adminSubscriptionUPI = adminUpi;
        await setSetting("adminUpi", adminUpi);
      }
      if (req.file)
        await setSetting("qrCodeUrl", `/uploads/${req.file.filename}`);
      res.json({ message: "Settings updated" });
    } catch (err) {
      console.log(err);
      res.status(500).json({ error: "Failed" });
    }
  },
);

// ================= COMMISSION ROUTES =================
app.put("/commission/paid/:bookingId", authMiddleware, async (req, res) => {
  try {
    const { screenshotNote } = req.body;
    const booking = await Booking.findById(req.params.bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    const comm = await Commission.findOneAndUpdate(
      { bookingId: req.params.bookingId, workerId: req.user.id },
      { status: "paid", screenshotNote: screenshotNote || "" },
      { new: true, upsert: true },
    );
    res.json(comm);
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.get("/commission/:bookingId", authMiddleware, async (req, res) => {
  try {
    res.json(
      (await Commission.findOne({
        bookingId: req.params.bookingId,
        workerId: req.user.id,
      })) || null,
    );
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.get("/worker/can-accept", authMiddleware, async (req, res) => {
  try {
    const worker = await Worker.findById(req.user.id);
    if (!worker) return res.status(404).json({ error: "Not found" });
    const isSubActive =
      worker.isSubscribed && worker.subscriptionEnd > new Date();
    if (isSubActive) return res.json({ canAccept: true, reason: "premium" });
    const unpaid = await Commission.findOne({
      workerId: req.user.id,
      status: "pending",
    });
    if (unpaid)
      return res.json({
        canAccept: false,
        reason: "unpaid_commission",
        commission: unpaid,
      });
    res.json({ canAccept: true });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.get("/admin/commissions", adminMiddleware, async (req, res) => {
  try {
    res.json(await Commission.find().sort({ createdAt: -1 }));
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.put("/admin/commission/approve/:id", adminMiddleware, async (req, res) => {
  try {
    await Commission.findByIdAndUpdate(
      req.params.id,
      { status: "approved" },
      { new: true },
    );
    res.json({ message: "Commission approved" });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.put("/admin/commission/reject/:id", adminMiddleware, async (req, res) => {
  try {
    await Commission.findByIdAndUpdate(req.params.id, {
      status: "pending",
      screenshotNote: "",
    });
    res.json({ message: "Rejected" });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// ================= PRICE NEGOTIATION =================
app.put("/booking/:id/set-price", authMiddleware, async (req, res) => {
  try {
    const { price } = req.body;
    if (!price || Number(price) < 1)
      return res.status(400).json({ error: "Valid price required" });
    const worker = await Worker.findById(req.user.id);
    const isSubActive =
      worker?.isSubscribed && worker?.subscriptionEnd > new Date();
    const commission = isSubActive ? 0 : Math.round(Number(price) * 0.1);
    const updated = await Booking.findByIdAndUpdate(
      req.params.id,
      {
        workerSetPrice: Number(price),
        commission,
        workerReceives: Number(price) - commission,
      },
      { new: true },
    );
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.put("/booking/:id/confirm-price", authMiddleware, async (req, res) => {
  try {
    const { price } = req.body;
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Not found" });
    if (booking.finalPriceConfirmed)
      return res.status(400).json({ error: "Already confirmed" });
    const updated = await Booking.findByIdAndUpdate(
      req.params.id,
      {
        confirmedPrice: Number(price),
        finalPrice: Number(price),
        finalPriceConfirmed: true,
      },
      { new: true },
    );
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.put("/booking/:id/customer-offer", authMiddleware, async (req, res) => {
  try {
    const { price } = req.body;
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Not found" });
    if (booking.customerSetPrice)
      return res.status(400).json({ error: "You already submitted an offer" });
    if (booking.finalPriceConfirmed)
      return res.status(400).json({ error: "Price already confirmed" });
    res.json(
      await Booking.findByIdAndUpdate(
        req.params.id,
        { customerSetPrice: Number(price) },
        { new: true },
      ),
    );
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// ================= WORKER EARNINGS =================
app.get("/worker/earnings", authMiddleware, async (req, res) => {
  try {
    const worker = await Worker.findById(req.user.id, "-password");
    if (!worker) return res.status(404).json({ error: "Not found" });
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const jobs = await Booking.find({
      worker: worker.name,
      paymentDone: true,
      createdAt: { $gte: oneYearAgo },
    });
    const monthlyMap = {};
    jobs.forEach((j) => {
      const d = new Date(j.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      monthlyMap[key] = (monthlyMap[key] || 0) + (j.finalPrice || 0);
    });
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      months.push({
        key,
        label: d.toLocaleString("default", { month: "short", year: "2-digit" }),
        amount: monthlyMap[key] || 0,
      });
    }
    res.json({
      months,
      totalEarnings: jobs.reduce((s, j) => s + (j.finalPrice || 0), 0),
      thisMonth: months[months.length - 1].amount,
    });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// ================= ADMIN CHAT =================
app.get("/admin/chats", adminMiddleware, async (req, res) => {
  try {
    const messages = await Chat.find().sort({ createdAt: -1 });
    const convMap = {};
    messages.forEach((m) => {
      const userId = m.senderRole === "admin" ? m.receiverId : m.senderId;
      const userName = m.senderRole === "admin" ? m.receiverId : m.senderName;
      const role = m.senderRole === "admin" ? m.receiverRole : m.senderRole;
      if (!convMap[userId])
        convMap[userId] = {
          userId,
          userName,
          senderRole: role,
          lastMessage: m.message,
          lastTime: m.createdAt,
          unread: 0,
        };
      if (!m.read && m.senderRole !== "admin") convMap[userId].unread++;
    });
    res.json(Object.values(convMap));
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.get("/admin/chat/:userId", adminMiddleware, async (req, res) => {
  try {
    const messages = await Chat.find({
      $or: [{ senderId: req.params.userId }, { receiverId: req.params.userId }],
    }).sort({ createdAt: 1 });
    await Chat.updateMany(
      { senderId: req.params.userId, read: false },
      { read: true },
    );
    res.json(messages);
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.post("/admin/chat/:userId", adminMiddleware, async (req, res) => {
  try {
    const { message, receiverRole } = req.body;
    const msg = await Chat.create({
      senderId: "admin",
      senderName: "EasyHome Support",
      senderRole: "admin",
      receiverId: req.params.userId,
      receiverRole,
      message,
    });
    const sock =
      workerSockets[req.params.userId] || customerSockets[req.params.userId];
    if (sock) io.to(sock).emit("new_admin_message", msg.toObject());
    res.json(msg);
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// ================= PROFILE ROUTES =================
app.get("/customer/profile", authMiddleware, async (req, res) => {
  try {
    const customer = await Customer.findById(req.user.id, "-password");
    if (!customer) return res.status(404).json({ error: "Not found" });
    const bookings = await Booking.find({
      customerId: req.user.id,
      removedByAdmin: { $ne: true },
    }).sort({ _id: -1 });
    res.json({ ...customer.toObject(), bookings });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});
app.put("/customer/profile", authMiddleware, async (req, res) => {
  try {
    const { name, phone } = req.body;
    res.json(
      await Customer.findByIdAndUpdate(
        req.user.id,
        { name, phone },
        { new: true, select: "-password" },
      ),
    );
  } catch {
    res.status(500).json({ error: "Update failed" });
  }
});
app.get("/worker/profile", authMiddleware, async (req, res) => {
  try {
    const worker = await Worker.findById(req.user.id, "-password");
    if (!worker) return res.status(404).json({ error: "Not found" });
    const acceptedJobs = await Booking.find({ worker: worker.name }).sort({
      _id: -1,
    });
    res.json({
      ...worker.toObject(),
      acceptedJobs,
      earnings: acceptedJobs.reduce((sum, j) => sum + (j.finalPrice || 0), 0),
    });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});
app.put("/worker/profile", authMiddleware, async (req, res) => {
  try {
    const {
      name,
      phone,
      service,
      location,
      pricePerHour,
      isUrgent,
      upiId,
      lat,
      lng,
    } = req.body;
    const price = Math.max(200, Number(pricePerHour) || 200); // ✅ min 200
    res.json(
      await Worker.findByIdAndUpdate(
        req.user.id,
        {
          name,
          phone,
          service,
          location,
          pricePerHour: price,
          isUrgent,
          upiId,
          lat,
          lng,
        },
        { new: true, select: "-password" },
      ),
    );
  } catch {
    res.status(500).json({ error: "Update failed" });
  }
});
app.put("/change-password", authMiddleware, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword)
      return res.status(400).json({ error: "Both fields required" });
    const Model = req.user.role === "customer" ? Customer : Worker;
    const user = await Model.findById(req.user.id);
    if (!(await bcrypt.compare(oldPassword, user.password)))
      return res.status(400).json({ error: "Old password is wrong" });
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ message: "Password changed" });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

// ================= NOTIFICATIONS =================
app.get("/notifications", authMiddleware, async (req, res) => {
  try {
    res.json(
      await Notification.find({ workerId: req.user.id })
        .sort({ createdAt: -1 })
        .limit(20),
    );
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.put("/notifications/read", authMiddleware, async (req, res) => {
  try {
    await Notification.updateMany(
      { workerId: req.user.id, read: false },
      { read: true },
    );
    res.json({ message: "Read" });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.delete("/notification/:id", authMiddleware, async (req, res) => {
  try {
    await Notification.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted" });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// ================= CHAT =================
app.get("/chat", authMiddleware, async (req, res) => {
  try {
    res.json(
      await Chat.find({
        $or: [{ senderId: req.user.id }, { receiverId: req.user.id }],
      }).sort({ createdAt: 1 }),
    );
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.post("/chat", authMiddleware, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Message required" });
    const msg = await Chat.create({
      senderId: req.user.id,
      senderName: req.user.name,
      senderRole: req.user.role,
      receiverId: "admin",
      receiverRole: "admin",
      message,
    });
    io.emit("admin_new_message", msg.toObject());
    res.json(msg);
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// ================= RATINGS =================
app.post("/rating", authMiddleware, async (req, res) => {
  try {
    const { workerId, workerName, bookingId, stars } = req.body;
    if (!workerId || !stars || stars < 1 || stars > 5)
      return res.status(400).json({ error: "Invalid rating" });
    if (await Rating.findOne({ bookingId, customerId: req.user.id }))
      return res.status(400).json({ error: "Already rated" });
    await Rating.create({
      workerId,
      workerName,
      customerId: req.user.id,
      customerName: req.user.name,
      bookingId,
      stars,
    });
    const allRatings = await Rating.find({ workerId });
    await Worker.findByIdAndUpdate(workerId, {
      rating:
        Math.round(
          (allRatings.reduce((s, r) => s + r.stars, 0) / allRatings.length) *
            10,
        ) / 10,
    });
    res.json({ message: "Rated" });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.get("/rating/:workerId", async (req, res) => {
  try {
    res.json(
      await Rating.find({ workerId: req.params.workerId }).sort({
        createdAt: -1,
      }),
    );
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.get("/rating/check/:bookingId", authMiddleware, async (req, res) => {
  try {
    res.json({
      rated: !!(await Rating.findOne({
        bookingId: req.params.bookingId,
        customerId: req.user.id,
      })),
    });
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// ================= PUBLIC ROUTES =================
app.get("/services", async (req, res) => {
  try {
    res.json(await Service.find({ active: true }).sort({ createdAt: 1 }));
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.get("/urgent", async (req, res) => {
  try {
    const ago = new Date();
    ago.setMonth(ago.getMonth() - 1);
    res.json(await Urgent.find({ createdAt: { $gte: ago } }).sort({ _id: -1 }));
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// ✅ Phone/email hidden from public
app.get("/urgent-workers", async (req, res) => {
  try {
    res.json(
      await Worker.find(
        { isUrgent: true, approved: true },
        "-password -phone -email",
      ).sort({ isSubscribed: -1, rating: -1 }),
    );
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.get("/workers", async (req, res) => {
  try {
    res.json(
      await Worker.find({ approved: true }, "-password -phone -email").sort({
        isSubscribed: -1,
        rating: -1,
      }),
    );
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/cities", async (req, res) => {
  try {
    res.json(await City.find({ active: true }).sort({ name: 1 }));
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.get("/normal-jobs", async (req, res) => {
  try {
    const ago = new Date();
    ago.setMonth(ago.getMonth() - 1);
    res.json(
      await Booking.find({
        urgency: "normal",
        status: "pending",
        removedByAdmin: { $ne: true },
        createdAt: { $gte: ago },
      })
        .sort({ createdAt: -1 })
        .limit(20),
    );
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

// ================= BOOKINGS =================
app.get("/bookings", authMiddleware, async (req, res) => {
  try {
    let data;
    if (req.user.role === "worker") {
      const worker = await Worker.findById(req.user.id);
      const allWorkerJobs = await Booking.find({
        service: worker.service,
        removedByAdmin: { $ne: true },
      }).sort({ _id: -1 });

      const workerArea = await findServiceArea(worker.lat, worker.lng);
      data = allWorkerJobs.filter((job) => {
        const alreadyAssignedToWorker =
          job.workerId === req.user.id || job.worker === worker.name;

        if (alreadyAssignedToWorker) return true;
        if (job.status !== "pending") return false;
        if (!workerArea.allowed || !workerArea.serviceRadius) return false;
        if (job.lat === null || job.lng === null) return false;

        const distance = geolib.getDistance(
          { latitude: Number(worker.lat), longitude: Number(worker.lng) },
          { latitude: Number(job.lat), longitude: Number(job.lng) },
        );

        return distance <= workerArea.serviceRadius;
      });
    } else {
      data = await Booking.find({
        customerId: req.user.id,
        removedByAdmin: { $ne: true },
      }).sort({ _id: -1 });
    }
    res.json(data);
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

app.post(
  "/booking",
  authMiddleware,
  enforceServiceArea,
  upload.single("image"),
  async (req, res) => {
    try {
      let price = Math.max(200, Number(req.body.pricePerHour) || 200); // ✅ min 200
      const urgency = req.body.urgency || "normal";
      const finalPrice = urgency === "urgent" ? Math.round(price * 1.1) : price;
      const service = req.body.service;
      const newBooking = new Booking({
        description: req.body.description,
        service,
        location: req.body.location,
        phone: req.body.phone,
        image: req.file ? req.file.filename : null,
        pricePerHour: price,
        urgency,
        finalPrice,
        customerId: req.user.id,
        lat: req.body.lat ? Number(req.body.lat) : null,
        lng: req.body.lng ? Number(req.body.lng) : null,
      });
      await newBooking.save();
      if (urgency === "urgent")
        await Urgent.create({
          title: req.body.description,
          price: `₹${finalPrice}`,
          location: req.body.location,
        });
      const matchingWorkers = await Worker.find({ service, approved: true });
      for (const worker of matchingWorkers) {
        await Notification.create({
          workerId: worker._id.toString(),
          bookingId: newBooking._id.toString(),
          service,
          description: req.body.description,
          location: req.body.location,
          finalPrice,
          urgency,
        });
        const socketId = workerSockets[worker._id.toString()];
        if (socketId)
          io.to(socketId).emit("new_job", {
            bookingId: newBooking._id,
            service,
            description: req.body.description,
            location: req.body.location,
            finalPrice,
            urgency,
          });
      }
      res.json(newBooking);
    } catch (err) {
      console.log(err);
      res.status(500).json({ error: "Server error" });
    }
  },
);

app.put("/booking/:id", authMiddleware, async (req, res) => {
  try {
    const updated = await Booking.findByIdAndUpdate(
      req.params.id,
      { status: "accepted", worker: req.user.name, workerId: req.user.id },
      { new: true },
    );
    await Worker.findByIdAndUpdate(req.user.id, { $inc: { jobs: 1 } });
    res.json(updated);
  } catch {
    res.status(500).json({ error: "Update failed" });
  }
});
app.put("/booking/:id/start", authMiddleware, async (req, res) => {
  try {
    res.json(
      await Booking.findByIdAndUpdate(
        req.params.id,
        { status: "ongoing" },
        { new: true },
      ),
    );
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.put("/booking/:id/complete", authMiddleware, async (req, res) => {
  try {
    res.json(
      await Booking.findByIdAndUpdate(
        req.params.id,
        { status: "completed" },
        { new: true },
      ),
    );
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});
app.put("/booking/:id/payment", authMiddleware, async (req, res) => {
  try {
    const { paymentMode } = req.body;
    const booking = await Booking.findByIdAndUpdate(
      req.params.id,
      { paymentDone: true, paymentMode },
      { new: true },
    );
    if (req.user.role === "worker" && booking.commission > 0) {
      const worker = await Worker.findById(req.user.id);
      const isSubActive =
        worker?.isSubscribed && worker?.subscriptionEnd > new Date();
      if (!isSubActive) {
        await Commission.findOneAndUpdate(
          { bookingId: req.params.id, workerId: req.user.id },
          {
            workerId: req.user.id,
            workerName: req.user.name,
            bookingId: req.params.id,
            amount: booking.commission,
            status: "pending",
          },
          { upsert: true, new: true },
        );
      }
    }
    res.json(booking);
  } catch {
    res.status(500).json({ error: "Failed" });
  }
});

app.get("/nearby-jobs", authMiddleware, enforceServiceArea, async (req, res) => {
  try {
    const { lat, lng, radius = 10000 } = req.query;
    if (!lat || !lng)
      return res.status(400).json({ error: "Location required" });
    const worker = await Worker.findById(req.user.id);
    if (!worker) return res.status(404).json({ error: "Not found" });
    const ago = new Date();
    ago.setMonth(ago.getMonth() - 1);
    const jobs = await Booking.find({
      service: worker.service,
      urgency: "normal",
      status: "pending",
      lat: { $ne: null },
      lng: { $ne: null },
      removedByAdmin: { $ne: true },
      createdAt: { $gte: ago },
    });
    res.json(
      jobs.filter(
        (job) =>
          geolib.getDistance(
            { latitude: Number(lat), longitude: Number(lng) },
            { latitude: job.lat, longitude: job.lng },
          ) <= Number(radius),
      ),
    );
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Failed" });
  }
});

server.listen(process.env.PORT || 5000, () => console.log("Server running"));
