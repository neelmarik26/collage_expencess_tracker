const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { isLoggedIn } = require('../middleware/authMiddleware');

router.get('/login', (req, res) => {
  if (req.session.user) {
    return (req.session.user.role === 'admin' || req.session.user.role === 'superadmin') ? res.redirect('/admin/dashboard') : res.redirect('/dashboard');
  }
  res.render('login', { error: null });
});

router.get('/register', (req, res) => {
  if (req.session.user) {
    return (req.session.user.role === 'admin' || req.session.user.role === 'superadmin') ? res.redirect('/admin/dashboard') : res.redirect('/dashboard');
  }
  res.render('register', { error: null });
});

router.post('/register', async (req, res) => {
  try {
    const { name, rollNumber, password } = req.body;
    const requestAdmin = req.body.requestAdmin === 'on';
    const existingUser = await User.findOne({ rollNumber });
    if (existingUser) {
      return res.render('register', { error: 'Roll number is already registered.' });
    }

    const user = new User({ name, rollNumber, password, role: 'student', isAdminRequested: requestAdmin });
    await user.save();

    req.session.user = { _id: user._id, name: user.name, rollNumber: user.rollNumber, role: user.role };
    return res.redirect((user.role === 'admin' || user.role === 'superadmin') ? '/admin/dashboard' : '/dashboard');
  } catch (err) {
    console.error(err);
    res.render('register', { error: 'Unable to create account. Please try again.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { rollNumber, password } = req.body;
    const user = await User.findOne({ rollNumber });
    if (!user) {
      return res.render('login', { error: 'Invalid roll number or password.' });
    }

    const isValid = await user.comparePassword(password);
    if (!isValid) {
      return res.render('login', { error: 'Invalid roll number or password.' });
    }

    req.session.user = { _id: user._id, name: user.name, rollNumber: user.rollNumber, role: user.role };
    res.redirect((user.role === 'admin' || user.role === 'superadmin') ? '/admin/dashboard' : '/dashboard');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Login failed. Please try again.' });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Check session and sync user role from DB
router.get('/check-session', isLoggedIn, async (req, res) => {
  try {
    const user = await User.findById(req.session.user._id);
    if (user && user.role !== req.session.user.role) {
      req.session.user.role = user.role;
      req.session.save();
    }
    res.json({ role: user?.role || req.session.user.role, name: user?.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check session' });
  }
});

module.exports = router;
