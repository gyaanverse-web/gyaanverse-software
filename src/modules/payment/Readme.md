Payment Module — Postman Testing Guide
Prerequisites
Env vars needed in .env:


RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=your_test_secret
RAZORPAY_WEBHOOK_SECRET=any_string_for_now
Step 1 — Sign in and get a session token

POST http://localhost:3000/api/auth/sign-in/email
Content-Type: application/json

{
  "email": "student@example.com",
  "password": "yourpassword"
}
The response sets a session cookie. In Postman, make sure "Automatically follow redirects" and "Save cookies" are on (they are by default). All subsequent requests will send the cookie automatically.

Alternatively, if you used phone OTP, the response returns { token } — add it as Authorization: Bearer <token> header on subsequent requests.

Step 2 — Create a paid exam (as owner/teacher)
First you need an exam with a price set. If you already have one, skip to Step 3.


POST http://localhost:3000/tenant/exams?tenant=yourslug
Content-Type: application/json

{
  "title": "JEE Mock Test 1",
  "price": "499.00",
  "maxAttempts": 1
}
Then publish it:


POST http://localhost:3000/tenant/exams/<examId>/publish?tenant=yourslug
Note the examId from the response.

Step 3 — Create a Razorpay order
Sign in as a student account, then:


POST http://localhost:3000/exams/<examId>/purchase
No body needed. Expected response:


{
  "orderId": "order_xxxxxxxxxxxxxxxxx",
  "amount": 49900,
  "currency": "INR",
  "keyId": "rzp_test_xxxxxxxxxxxx"
}
Save the orderId.

Step 4 — Simulate payment and generate signature
In real flow the frontend opens Razorpay checkout and gets back razorpay_payment_id + razorpay_signature. In Postman you simulate this manually.

Generate the signature — run this in a terminal (replace values):


node -e "
const crypto = require('crypto');
const orderId = 'order_xxxxxxxxxxxxxxxxx';
const paymentId = 'pay_test_xxxxxxxxxxxx';  // make up a test payment ID
const secret = 'your_test_secret';
const sig = crypto.createHmac('sha256', secret)
  .update(orderId + '|' + paymentId)
  .digest('hex');
console.log(sig);
"
For the paymentId, use a real one from Razorpay's test dashboard — after Step 3, a test order appears in your Razorpay Test Dashboard under Orders. You can capture it there and get a real pay_test_... ID. Alternatively use Razorpay's test checkout flow once to get a real payment ID.

Step 5 — Confirm the payment

POST http://localhost:3000/exams/<examId>/purchase/confirm
Content-Type: application/json

{
  "razorpayOrderId": "order_xxxxxxxxxxxxxxxxx",
  "razorpayPaymentId": "pay_xxxxxxxxxxxxxxxxx",
  "razorpaySignature": "<signature from step 4>"
}
Expected response:


{ "success": true }
Step 6 — Verify purchase status

GET http://localhost:3000/exams/<examId>/purchase/status
Expected:


{ "purchased": true }
Error cases to test
Scenario	How to trigger	Expected
Free exam purchase	Use an exam with no price	422 This exam is free...
Double purchase	Hit Step 3 twice	409 Already purchased
Wrong signature	Change one char in signature	400 Invalid payment signature
Unauthenticated	Remove cookie/token	401
Already confirmed	Hit Step 5 twice	409 Payment already confirmed