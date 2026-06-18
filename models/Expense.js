const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  amount: { type: Number, required: true, min: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  description: { type: String, trim: true, default: '' },
  billImage: { type: String, required: true },
  billImageKey: { type: String, trim: true, default: '' },
  billImageStorage: { type: String, enum: ['', 'local', 'supabase-s3'], default: '' },
  date: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Expense', expenseSchema);
