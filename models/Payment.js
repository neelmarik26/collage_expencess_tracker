const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  billId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill', required: true },
  amountDue: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['Due', 'Paid'], default: 'Due' }
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);
