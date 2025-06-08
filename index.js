const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');
const stream = require('stream');
require('dotenv').config(); 


const app = express();
const PORT = process.env.PORT || 5000;

// MongoDB Connection
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
let db, bucket;

async function connectToMongoDB() {
  try {
    await client.connect();
    db = client.db('fileStorage');
    bucket = new GridFSBucket(db, { bucketName: 'uploads' });
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('MongoDB connection error:', err);
  }
}
connectToMongoDB();

// Nodemailer setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const pendingApprovals = new Map();

app.use(cors());
app.use(express.json());

//static file
app.use(express.static(path.join(__dirname,'./client/build')))

app.get('*', function(req, res){
    res.sendFile(path.join(__dirname, './client/build/index.html'))
})

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// Multer error handling
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error('Multer error:', err.message, err.stack);
    return res.status(400).json({ error: `Multer error: ${err.message}` });
  }
  next(err);
});

// Upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
  console.log('Received upload request:', { category: req.body.category, file: req.file?.originalname });
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const category = (req.body.category || 'Others').replace(/[^a-zA-Z0-9\s\-]/g, '');

  try {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const filename = `${uniqueSuffix}-${req.file.originalname}`;
    const readableStream = new stream.PassThrough();
    readableStream.end(req.file.buffer);

    const uploadStream = bucket.openUploadStream(filename, {
      metadata: { category, originalName: req.file.originalname },
    });
    readableStream.pipe(uploadStream);

    uploadStream.on('finish', () => {
      res.json({
        id: Date.now(),
        name: req.file.originalname,
        category,
        url: `${process.env.BASE_URL}/file/${uploadStream.id}`,
      });
    });

    uploadStream.on('error', (err) => {
      console.error('Error uploading to GridFS:', err);
      res.status(500).json({ error: 'Failed to save file' });
    });
  } catch (err) {
    console.error('Upload error:', err.message, err.stack);
    res.status(500).json({ error: `Failed to save file: ${err.message}` });
  }
});

// Serve file
app.get('/file/:id', async (req, res) => {
  try {
    const fileId = new ObjectId(req.params.id);
    const downloadStream = bucket.openDownloadStream(fileId);

    downloadStream.on('data', (chunk) => {
      res.write(chunk);
    });

    downloadStream.on('end', () => {
      res.end();
    });

    downloadStream.on('error', (err) => {
      console.error('Error retrieving file:', err);
      res.status(404).json({ error: 'File not found' });
    });
  } catch (err) {
    console.error('Error serving file:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Verify password and request approval
app.post('/verify-pdf-access', (req, res) => {
  const { pdfId, password } = req.body;
  const CORRECT_PASSWORD = process.env.PDF_PASSWORD;

  if (password !== CORRECT_PASSWORD) {
    console.error('Incorrect password attempt:', { pdfId });
    return res.status(401).json({ error: 'Incorrect password' });
  }

  const token = uuidv4();
  pendingApprovals.set(token, { pdfId, userPassword: password, approved: false });

  const approvalLink = `${process.env.BASE_URL}/approve/${token}`;
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_USER,
    subject: `Click to Approve Access for PDF ID ${pdfId}`,
    html: `
      <h3>File Access Approval Request</h3>
      <p>A user is requesting access to PDF ID <strong>${pdfId}</strong>.</p>
      <p><a href="${approvalLink}">Click here to approve access</a></p>
    `,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error('Error sending email:', error.message, error.stack);
      return res.status(500).json({ error: 'Failed to send email' });
    }
    console.log(`Email sent: ${info.response}, Approval link: ${approvalLink}`);
    res.json({ token, message: 'Waiting for approval' });
  });
});

// Approval page
app.get('/approve/:token', (req, res) => {
  const { token } = req.params;
  const approval = pendingApprovals.get(token);

  if (!approval) {
    return res.status(404).sendFile(path.join(__dirname, 'public', 'error.html'));
  }

  approval.approved = true;
  pendingApprovals.set(token, approval);
  res.sendFile(path.join(__dirname, 'public', 'approved.html'));
});

// Approval status check
app.get('/check-approval/:token', (req, res) => {
  const { token } = req.params;
  const approval = pendingApprovals.get(token);

  if (!approval) {
    return res.status(404).json({ error: 'Invalid or expired token' });
  }

  if (approval.approved) {
    pendingApprovals.delete(token);
    return res.json({ approved: true, pdfId: approval.pdfId });
  }

  res.json({ approved: false });
});

// Category list
app.get('/categories', (req, res) => {
  const categories = [
    'Schematics', 'BoardViews', 'SPI Bios', 'T2 Bios', 'Usb -C Bios', 
    'Impedance DV / G.R Value', 'Case Study', 'Digital Oscilloscope', 
    'Images', 'Videos'
  ];
  res.json(categories);
});

// Files in category
app.get('/files/:category', async (req, res) => {
  const category = req.params.category;

  try {
    const files = await bucket.find({ 'metadata.category': category }).toArray();
    const fileList = files.map((file, index) => ({
      id: index + 1,
      name: file.metadata.originalName,
      url: `${process.env.BASE_URL}/file/${file._id}`,
    }));
    res.json(fileList);
  } catch (err) {
    console.error('Error fetching files:', err);
    res.status(500).json({ error: 'Failed to fetch files' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on ${process.env.BASE_URL}`);
});
