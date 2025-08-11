import { Router } from 'express';

const router = Router();

// Test endpoint for debugging
router.post('/', (req, res) => {
  console.log('Test endpoint hit:', {
    body: req.body,
    headers: req.headers,
  });
  
  res.json({
    message: 'Test endpoint successful',
    received: req.body,
    timestamp: new Date().toISOString()
  });
});

export default router;