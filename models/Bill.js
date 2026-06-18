const mongoose = require('mongoose');

const billSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  totalAmount: { type: Number, required: true, min: 0 },
  billImage: { type: String, trim: true, default: '' },
  billImageKey: { type: String, trim: true, default: '' },
  billImageStorage: { type: String, enum: ['', 'local', 'supabase-s3'], default: '' },
  date: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Bill', billSchema);
