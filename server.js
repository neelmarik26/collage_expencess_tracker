const path = require('path');
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const studentRoutes = require('./routes/student');
const { isLoggedIn } = require('./middleware/authMiddleware');
const User = require('./models/User');

const http = require('http');
let io = null;

const app = express();
const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('Error: MONGO_URI is not defined. Set it in your .env file.');
  process.exit(1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'super-secret-key',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: MONGO_URI }),
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user;
  next();
});

app.use('/', authRoutes);
app.use('/admin', isLoggedIn, adminRoutes);
app.use('/', isLoggedIn, studentRoutes);

app.get('/', (req, res) => {
  if (req.session.user) {
    return (req.session.user.role === 'admin' || req.session.user.role === 'superadmin') ? res.redirect('/admin/dashboard') : res.redirect('/dashboard');
  }
  res.redirect('/login');
});

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log('Connected to MongoDB');

    (async () => {
      try {
        const defaultAdminRoll = process.env.DEFAULT_ADMIN_ROLL || 'admin';
        const defaultAdminPass = process.env.DEFAULT_ADMIN_PASS || 'admin123';
        let admin = await User.findOne({ rollNumber: defaultAdminRoll });
        if (!admin) {
          admin = new User({ name: 'Default Superadmin', rollNumber: defaultAdminRoll, password: defaultAdminPass, role: 'superadmin' });
          await admin.save();
          console.log(`Created default superadmin (${defaultAdminRoll})`);
        } else if (admin.role !== 'superadmin') {
          admin.role = 'superadmin';
          await admin.save();
          console.log(`Updated existing user (${defaultAdminRoll}) to superadmin`);
        }
      } catch (err) {
        console.error('Error ensuring default admin:', err);
      }
    })();

    const server = http.createServer(app);
    try {
      const { Server } = require('socket.io');
      io = new Server(server);
      app.set('io', io);
      io.on('connection', (socket) => {
        console.log('Socket connected:', socket.id);
      });
    } catch (e) {
      console.warn('socket.io not available:', e.message);
    }

    server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err);
  });
