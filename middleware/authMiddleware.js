const User = require('../models/User');

const isLoggedIn = (req, res, next) => {
  if (req.session && req.session.user) {
    return next();
  }
  res.redirect('/login');
};

const isAdmin = (req, res, next) => {
  if (req.session.user && (req.session.user.role === 'admin' || req.session.user.role === 'superadmin')) {
    return next();
  }
  res.status(403).send('Access denied. Admins only.');
};

const isSuperAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'superadmin') {
    return next();
  }
  res.status(403).send('Access denied. Superadmin only.');
};

module.exports = { isLoggedIn, isAdmin, isSuperAdmin };
