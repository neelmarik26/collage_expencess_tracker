const express = require('express');
const multer = require('multer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Expense = require('../models/Expense');
const { isAdmin, isSuperAdmin } = require('../middleware/authMiddleware');
const {
  deleteStoredImages,
  hydrateStoredImageUrls,
  imageFromRecord,
  uploadStoredImage
} = require('../services/storageService');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed.'));
    }
    cb(null, true);
  }
});

const uploadImage = (fieldName) => (req, res, next) => {
  upload.single(fieldName)(req, res, (err) => {
    if (err) {
      return res.redirect(`/admin/dashboard?error=${encodeURIComponent(err.message || 'Image upload failed.')}`);
    }
    next();
  });
};

const adminPayerRoles = ['student', 'admin'];

const csvCell = (value) => {
  const text = value === null || typeof value === 'undefined' ? '' : String(value);
  const formulaSafeText = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${formulaSafeText.replace(/"/g, '""')}"`;
};

router.get('/dashboard', isAdmin, async (req, res) => {
  try {
    // Sync user role from database
    const dbUser = await User.findById(req.session.user._id);
    if (dbUser && dbUser.role !== req.session.user.role) {
      req.session.user.role = dbUser.role;
      req.session.save();
    }
    
    // Redirect if user was demoted to student
    if (req.session.user.role === 'student') {
      return res.redirect('/dashboard');
    }
    
    const students = await User.find({ role: { $in: adminPayerRoles } }).sort({ name: 1 });
    const bills = await Bill.find().sort({ date: -1 });
    const payments = await Payment.find().populate('studentId billId').sort({ studentId: 1 });
    const pendingRequests = req.session.user.role === 'superadmin'
      ? await User.find({ role: 'student', isAdminRequested: true }).sort({ name: 1 })
      : [];
    const allExpenses = await Expense.find().sort({ date: -1 }).populate('createdBy');
    const expenses = allExpenses.slice(0, 50);
    await hydrateStoredImageUrls(bills);
    await hydrateStoredImageUrls(expenses);

    const summary = students.map((student) => {
      const studentPayments = payments.filter((payment) => payment.studentId && payment.studentId._id.equals(student._id));
      const totalDue = studentPayments.reduce((sum, item) => sum + item.amountDue, 0);
      const statusCounts = studentPayments.reduce(
        (acc, item) => {
          if (item.status === 'Paid') acc.paid += 1;
          else acc.due += 1;
          return acc;
        },
        { paid: 0, due: 0 }
      );
      return { student, totalDue, paid: statusCounts.paid, due: statusCounts.due };
    });

    const totalAssigned = payments.reduce((sum, payment) => sum + payment.amountDue, 0);
    const totalCollected = payments.filter((payment) => payment.status === 'Paid').reduce((sum, payment) => sum + payment.amountDue, 0);
    const totalDue = payments.filter((payment) => payment.status === 'Due').reduce((sum, payment) => sum + payment.amountDue, 0);
    const totalExpenses = allExpenses.reduce((sum, expense) => sum + expense.amount, 0);
    const netBalance = totalCollected - totalExpenses;
    const totalStudents = students.length;
    const totalPaidCount = payments.filter((payment) => payment.status === 'Paid').length;
    const totalDueCount = payments.filter((payment) => payment.status === 'Due').length;

    res.render('admin', {
      students,
      bills,
      payments,
      summary,
      pendingRequests,
      expenses,
      totalAssigned,
      totalCollected,
      totalDue,
      totalExpenses,
      netBalance,
      totalStudents,
      totalPaidCount,
      totalDueCount,
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.render('admin', {
      students: [],
      bills: [],
      payments: [],
      summary: [],
      pendingRequests: [],
      expenses: [],
      totalAssigned: 0,
      totalCollected: 0,
      totalDue: 0,
      totalExpenses: 0,
      netBalance: 0,
      totalStudents: 0,
      totalPaidCount: 0,
      totalDueCount: 0,
      error: 'Failed to load dashboard.',
      success: null
    });
  }
});

router.post('/approve/:userId', isSuperAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findByIdAndUpdate(userId, { role: 'admin', isAdminRequested: false }, { new: true });
    const io = req.app.get('io');
    if (io) io.emit('roleChanged', { userId: user._id, newRole: user.role });
    res.redirect('/admin/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).send('Unable to approve admin request.');
  }
});

router.post('/reject/:userId', isSuperAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    await User.findByIdAndUpdate(userId, { isAdminRequested: false });
    const io = req.app.get('io');
    if (io) io.emit('roleChanged', { userId, newRole: 'student' });
    res.redirect('/admin/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).send('Unable to reject admin request.');
  }
});

// Superadmin: Get all admins list
router.get('/manage-admins', isSuperAdmin, async (req, res) => {
  try {
    const admins = await User.find({ role: 'admin' }).sort({ name: 1 });
    const pendingRequests = await User.find({ role: 'student', isAdminRequested: true }).sort({ name: 1 });
    res.render('manage-admins', { admins, pendingRequests, error: null, success: null });
  } catch (err) {
    console.error(err);
    res.render('manage-admins', { admins: [], pendingRequests: [], error: 'Failed to load admins.', success: null });
  }
});

// Superadmin: Delete an admin (demote to student)
router.post('/delete-admin/:userId', isSuperAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    await User.findByIdAndUpdate(userId, { role: 'student', isAdminRequested: false });
    const io = req.app.get('io');
    if (io) io.emit('roleChanged', { userId, newRole: 'student' });
    res.redirect('/admin/manage-admins');
  } catch (err) {
    console.error(err);
    res.status(500).send('Unable to delete admin.');
  }
});

router.post('/upload-bill', isAdmin, uploadImage('billImage'), async (req, res) => {
  try {
    const { title, totalAmount } = req.body;
    const amount = Number(totalAmount);
    if (!title || isNaN(amount) || amount <= 0 || !req.file) {
      return res.redirect('/admin/dashboard?error=Bill%20title%2C%20amount%2C%20and%20image%20are%20required.');
    }

    const uploadedImage = await uploadStoredImage(req.file, 'budget-covers');
    const bill = new Bill({
      title,
      totalAmount: amount,
      billImage: uploadedImage.url,
      billImageKey: uploadedImage.key,
      billImageStorage: uploadedImage.storage
    });
    await bill.save();

    // Include both students and admins (but not superadmins) as payers
    const payers = await User.find({ role: { $in: adminPayerRoles } });
    const perStudentAmount = Number((bill.totalAmount / Math.max(payers.length, 1)).toFixed(2));

    const paymentEntries = payers.map((payer) => ({
      studentId: payer._id,
      billId: bill._id,
      amountDue: perStudentAmount,
      status: 'Due'
    }));

    await Payment.insertMany(paymentEntries);
    // notify realtime
    const io = req.app.get('io');
    if (io) io.emit('billCreated', { bill: bill._id });
    res.redirect('/admin/dashboard');
  } catch (err) {
    console.error(err);
    res.render('admin', {
      error: 'Unable to upload bill. Please try again.',
      success: null,
      students: [],
      bills: [],
      payments: [],
      summary: [],
      pendingRequests: [],
      expenses: [],
      totalAssigned: 0,
      totalCollected: 0,
      totalDue: 0,
      totalExpenses: 0,
      netBalance: 0,
      totalStudents: 0,
      totalPaidCount: 0,
      totalDueCount: 0
    });
  }
});

router.post('/mark-paid/:paymentId', isAdmin, async (req, res) => {
  try {
    const { paymentId } = req.params;
    await Payment.findByIdAndUpdate(paymentId, { status: 'Paid' });
    const io = req.app.get('io');
    if (io) io.emit('paymentUpdated', { paymentId, status: 'Paid' });
    res.redirect('/admin/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).send('Unable to mark payment paid.');
  }
});

// Set uniform amount for all students (create a bill without image)
router.post('/set-uniform', isAdmin, uploadImage('billImage'), async (req, res) => {
  try {
    const { title, perStudentAmount } = req.body;
    const amount = Number(perStudentAmount);
    if (!title || isNaN(amount) || amount <= 0 || !req.file) {
      return res.redirect('/admin/dashboard?error=Budget%20title%2C%20amount%2C%20and%20cover%20page%20are%20required.');
    }

    // Include both students and admins (but not superadmins) as payers
    const payers = await User.find({ role: { $in: adminPayerRoles } });
    const uploadedImage = await uploadStoredImage(req.file, 'budget-covers');
    const bill = new Bill({
      title,
      totalAmount: amount * Math.max(payers.length, 1),
      billImage: uploadedImage.url,
      billImageKey: uploadedImage.key,
      billImageStorage: uploadedImage.storage
    });
    await bill.save();

    const paymentEntries = payers.map((payer) => ({
      studentId: payer._id,
      billId: bill._id,
      amountDue: amount,
      status: 'Due'
    }));

    await Payment.insertMany(paymentEntries);
    const io = req.app.get('io');
    if (io) io.emit('billCreated', { bill: bill._id });
    res.redirect('/admin/dashboard');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/dashboard');
  }
});

// Edit specific student's payment amount
router.post('/edit-amount/:paymentId', isAdmin, async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { amount } = req.body;
    const num = Number(amount);
    if (isNaN(num) || num < 0) return res.redirect('/admin/dashboard');
    await Payment.findByIdAndUpdate(paymentId, { amountDue: num });
    const io = req.app.get('io');
    if (io) io.emit('paymentUpdated', { paymentId, amount: num });
    res.redirect('/admin/dashboard');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/dashboard');
  }
});

// Create an expense (admin spending)
router.post('/expenses/create', isAdmin, uploadImage('billImage'), async (req, res) => {
  try {
    const { title, amount, description } = req.body;
    const num = Number(amount);
    if (!title || isNaN(num) || num <= 0 || !req.file) {
      return res.redirect('/admin/dashboard?error=Expense%20title%2C%20amount%2C%20and%20bill%20image%20are%20required.');
    }
    
    const uploadedImage = await uploadStoredImage(req.file, 'expense-bills');
    const expense = new Expense({ 
      title, 
      amount: num, 
      description: description || '', 
      createdBy: req.session.user._id,
      billImage: uploadedImage.url,
      billImageKey: uploadedImage.key,
      billImageStorage: uploadedImage.storage
    });
    await expense.save();
    const io = req.app.get('io');
    if (io) io.emit('expenseCreated', { expenseId: expense._id });
    res.redirect('/admin/dashboard');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/dashboard');
  }
});

// Export CSV of payments and expenses
router.get('/export-csv', isAdmin, async (req, res) => {
  try {
    const payments = await Payment.find().populate('studentId billId');
    const expenses = await Expense.find().populate('createdBy');

    const rows = [['type', 'student', 'bill_title', 'amount', 'status', 'createdBy', 'expenseTitle', 'expenseAmount', 'expenseDate']];
    payments.forEach((p) => {
      rows.push(['payment', p.studentId?.name || '', p.billId?.title || '', p.amountDue, p.status, '', '', '', '']);
    });
    expenses.forEach((e) => {
      rows.push(['expense', '', '', '', '', e.createdBy?.name || '', e.title, e.amount, e.date.toISOString()]);
    });
    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="report.csv"');
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.redirect('/admin/dashboard');
  }
});

// Reset planning: Delete all payments and expenses but keep students
router.post('/reset-planning', isSuperAdmin, async (req, res) => {
  try {
    const bills = await Bill.find({}, 'billImage billImageKey billImageStorage');
    const expenses = await Expense.find({}, 'billImage billImageKey billImageStorage');
    await deleteStoredImages([
      ...bills.map((bill) => imageFromRecord(bill)),
      ...expenses.map((expense) => imageFromRecord(expense))
    ]);

    await Payment.deleteMany({});
    await Expense.deleteMany({});
    await Bill.deleteMany({});
    res.json({ success: true, message: 'Planning reset successfully. All payments, expenses, and bills have been deleted.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Error resetting planning.' });
  }
});

// Student summary dashboard
router.get('/students', isAdmin, async (req, res) => {
  try {
    // Get all students and admins (not superadmin)
    const students = await User.find({ role: { $in: adminPayerRoles } }).sort({ name: 1 });
    
    // Get all payments
    const payments = await Payment.find().populate('studentId billId').sort({ studentId: 1 });
    
    // Get all expenses
    const expenses = await Expense.find().populate('createdBy');
    
    // Build student summary with payment status
    const studentSummary = students.map((student) => {
      const studentPayments = payments.filter((payment) => payment.studentId && payment.studentId._id.equals(student._id));
      const totalDue = studentPayments.reduce((sum, item) => sum + item.amountDue, 0);
      const paidAmount = studentPayments.filter((p) => p.status === 'Paid').reduce((sum, item) => sum + item.amountDue, 0);
      const dueAmount = totalDue - paidAmount;
      const statusCounts = {
        paid: studentPayments.filter((p) => p.status === 'Paid').length,
        due: studentPayments.filter((p) => p.status === 'Due').length
      };
      return {
        student,
        totalDue,
        paidAmount,
        dueAmount,
        paid: statusCounts.paid,
        due: statusCounts.due,
        status: dueAmount > 0 ? 'Due' : 'Paid'
      };
    });
    
    res.render('student-summary', { studentSummary, expenses, error: null });
  } catch (err) {
    console.error('Student summary error:', err);
    res.render('student-summary', { studentSummary: [], expenses: [], error: 'Failed to load student summary.' });
  }
});

module.exports = router;
