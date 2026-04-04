import Razorpay from "razorpay";

const keyId = process.env.RZP_KEY_ID;
const keySecret = process.env.RZP_KEY_SECRET;

if (!keyId || !keySecret) {
  throw new Error("Missing Razorpay env vars: RZP_KEY_ID / RZP_KEY_SECRET");
}

const razorpay = new Razorpay({
  key_id: keyId,
  key_secret: keySecret,
});

export default razorpay;