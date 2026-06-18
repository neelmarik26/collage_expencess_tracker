const express = require('express');
const Payment = require('../models/Payment');
const Bill = require('../models/Bill');
const User = require('../models/User');
const Expense = require('../models/Expense');
const { hydrateStoredImageUrls } = require('../services/storageService');

const router = express.Router();

router.get('/dashboard', async (req, res) => {
  try {
    // Sync user role from database
    const dbUser = await User.findById(req.session.user._id);
    if (dbUser && dbUser.role !== req.session.user.role) {
      req.session.user.role = dbUser.role;
      req.session.save();
    }
    
    // Redirect if user role changed to admin/superadmin
    if (req.session.user.role === 'admin' || req.session.user.role === 'superadmin') {
      return res.redirect('/admin/dashboard');
    }
    
    const studentId = req.session.user._id;
    const payments = await Payment.find({ studentId }).populate('billId').sort({ createdAt: -1 });
    const visibleBillsById = new Map();
    payments.forEach((payment) => {
      if (payment.billId) {
        visibleBillsById.set(String(payment.billId._id), payment.billId);
      }
    });
    await hydrateStoredImageUrls([...visibleBillsById.values()]);

    // Budget for this student (total assigned)
    const totalAssigned = payments.reduce((sum, p) => sum + p.amountDue, 0);
    const paidByStudent = payments.filter((p) => p.status === 'Paid').reduce((sum, p) => sum + p.amountDue, 0);

    // Total budget and actual collected across all students/admins
    const allPayments = await Payment.find().populate('billId studentId');
    const totalBudget = allPayments.reduce((sum, p) => sum + p.amountDue, 0);
    const totalCollected = allPayments.filter((p) => p.status === 'Paid').reduce((sum, p) => sum + p.amountDue, 0);

    // For each bill in student's payments, compute who paid and who not
    const billIds = payments.filter((p) => p.billId).map((p) => p.billId._id);
    const relatedPayments = await Payment.find({ billId: { $in: billIds } }).populate('studentId');
    const billDetails = payments.filter((p) => p.billId).map((p) => {
      const group = relatedPayments.filter((rp) => rp.billId.equals(p.billId._id));
      const payers = group.filter((g) => g.status === 'Paid' && g.studentId).map((g) => ({ name: g.studentId.name, rollNumber: g.studentId.rollNumber }));
      const nonPayers = group.filter((g) => g.status !== 'Paid' && g.studentId).map((g) => ({ name: g.studentId.name, rollNumber: g.studentId.rollNumber }));
      return { bill: p.billId, yourPayment: p, payers, nonPayers };
    });

    const allExpenses = await Expense.find().sort({ date: -1 }).populate('createdBy');
    const expenses = allExpenses.slice(0, 50);
    await hydrateStoredImageUrls(expenses);
    const totalExpenses = allExpenses.reduce((sum, expense) => sum + expense.amount, 0);
    const netBalance = totalCollected - totalExpenses;
    res.render('student', {
      payments,
      totalDue: totalAssigned - paidByStudent,
      totalPaid: paidByStudent,
      budget: totalBudget,
      totalBudget,
      totalCollected,
      totalExpenses,
      netBalance,
      billDetails,
      expenses
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.render('student', {
      payments: [],
      totalDue: 0,
      totalPaid: 0,
      budget: 0,
      totalBudget: 0,
      totalCollected: 0,
      totalExpenses: 0,
      netBalance: 0,
      billDetails: [],
      expenses: []
    });
  }
});

module.exports = router;
