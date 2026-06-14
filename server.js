require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const PayOS = require("@payos/node");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── PayOS instance ────────────────────────────────────────────────────────────
const payos = new PayOS(
  process.env.PAYOS_CLIENT_ID,
  process.env.PAYOS_API_KEY,
  process.env.PAYOS_CHECKSUM_KEY
);

// ─── Middleware ────────────────────────────────────────────────────────────────
// Cho phép tất cả origin (frontend build được serve cùng server nên không cần CORS)
app.use(cors());
app.use(express.json());

// ─── Serve React frontend (Vite build output) ─────────────────────────────────
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// ─── In-memory store cho trạng thái đơn hàng ─────────────────────────────────
// Trong production nên dùng database (MongoDB, Redis, v.v.)
const orderStore = new Map();

// ─── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/create-payment-link
 * Body: { machineId, machineName, service, amount }
 * Returns: { checkoutUrl, orderCode, paymentLinkId }
 */
app.post("/api/create-payment-link", async (req, res) => {
  try {
    const { machineId, machineName, service, amount } = req.body;

    if (!machineId || !amount) {
      return res
        .status(400)
        .json({ error: "Thiếu thông tin: machineId và amount là bắt buộc" });
    }

    // Tạo orderCode là số nguyên dương, unique, tối đa 9 chữ số
    const orderCode = Number(String(Date.now()).slice(-8));

    // PUBLIC_URL được set khi dùng tunnel (ngrok, localtunnel, ...)
    // Fallback về localhost nếu chạy dev
    const publicUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
    const frontendUrl = process.env.FRONTEND_URL || publicUrl;

    const paymentData = {
      orderCode,
      amount: Math.round(amount), // số nguyên, đơn vị VNĐ
      description: `Laundry-${machineId}`.slice(0, 25), // max 25 ký tự
      returnUrl: `${frontendUrl}/?payment=success&orderCode=${orderCode}`,
      cancelUrl: `${frontendUrl}/?payment=cancel&orderCode=${orderCode}`,
      items: [
        {
          name: `${machineName} - ${service}`.slice(0, 100),
          quantity: 1,
          price: Math.round(amount),
        },
      ],
    };

    const paymentLink = await payos.createPaymentLink(paymentData);

    // Lưu trạng thái đơn hàng
    orderStore.set(String(orderCode), {
      status: "PENDING",
      machineId,
      machineName,
      service,
      amount,
      createdAt: new Date().toISOString(),
      paymentLinkId: paymentLink.paymentLinkId,
    });

    console.log(`[PayOS] Tạo đơn hàng #${orderCode} - ${machineName} - ${amount}đ`);

    res.json({
      success: true,
      checkoutUrl: paymentLink.checkoutUrl,
      orderCode,
      paymentLinkId: paymentLink.paymentLinkId,
      qrCode: paymentLink.qrCode,
    });
  } catch (error) {
    console.error("[PayOS] Lỗi tạo payment link:", error);
    res.status(500).json({
      error: "Không thể tạo link thanh toán",
      detail: error.message,
    });
  }
});

/**
 * GET /api/payment-status/:orderCode
 * Frontend polling để kiểm tra trạng thái đơn hàng
 */
app.get("/api/payment-status/:orderCode", async (req, res) => {
  try {
    const { orderCode } = req.params;

    const localOrder = orderStore.get(String(orderCode));

    if (!localOrder) {
      return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
    }

    if (localOrder.status === "PAID") {
      return res.json({ status: "PAID", orderCode, ...localOrder });
    }

    try {
      const paymentInfo = await payos.getPaymentLinkInformation(orderCode);

      if (paymentInfo.status === "PAID") {
        localOrder.status = "PAID";
        localOrder.paidAt = new Date().toISOString();
        orderStore.set(String(orderCode), localOrder);
        console.log(`[PayOS] Đơn hàng #${orderCode} ĐÃ THANH TOÁN`);
      } else if (paymentInfo.status === "CANCELLED") {
        localOrder.status = "CANCELLED";
        orderStore.set(String(orderCode), localOrder);
      }

      return res.json({ status: localOrder.status, orderCode, ...localOrder });
    } catch {
      return res.json({ status: localOrder.status, orderCode, ...localOrder });
    }
  } catch (error) {
    console.error("[PayOS] Lỗi kiểm tra trạng thái:", error);
    res.status(500).json({ error: "Lỗi kiểm tra trạng thái thanh toán" });
  }
});

/**
 * POST /api/webhook
 * payOS gọi endpoint này sau khi thanh toán thành công/thất bại
 */
app.post("/api/webhook", async (req, res) => {
  try {
    const webhookData = payos.verifyPaymentWebhookData(req.body);
    const { orderCode, code, desc, data } = webhookData;

    console.log(`[Webhook] Nhận webhook cho đơn #${orderCode}: ${code} - ${desc}`);

    if (code === "00") {
      const order = orderStore.get(String(orderCode));
      if (order) {
        order.status = "PAID";
        order.paidAt = new Date().toISOString();
        order.transactionId = data?.reference;
        orderStore.set(String(orderCode), order);
        console.log(`[Webhook] Đơn hàng #${orderCode} THANH TOÁN THÀNH CÔNG`);
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error("[Webhook] Lỗi xử lý webhook:", error);
    res.status(400).json({ error: "Webhook không hợp lệ" });
  }
});

/**
 * POST /api/cancel-payment/:orderCode
 */
app.post("/api/cancel-payment/:orderCode", async (req, res) => {
  try {
    const { orderCode } = req.params;
    await payos.cancelPaymentLink(orderCode, "Người dùng huỷ đơn hàng");

    const order = orderStore.get(String(orderCode));
    if (order) {
      order.status = "CANCELLED";
      orderStore.set(String(orderCode), order);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("[PayOS] Lỗi huỷ đơn hàng:", error);
    res.status(500).json({ error: "Không thể huỷ đơn hàng" });
  }
});

/**
 * GET /api/health
 */
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Laundry IoT Backend đang chạy",
    publicUrl: process.env.PUBLIC_URL || `http://localhost:${PORT}`,
    timestamp: new Date().toISOString(),
  });
});

// ─── SPA fallback — mọi route không phải /api đều trả về index.html ──────────
app.get("*", (req, res) => {
  const indexPath = path.join(publicDir, "index.html");
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(404).send(
        "Frontend chưa được build. Chạy: cd ../laundry-iot-web && npm run build"
      );
    }
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  console.log(`\n🚀 Server chạy tại:`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://0.0.0.0:${PORT}`);
  if (process.env.PUBLIC_URL) {
    console.log(`   Public:  ${publicUrl}  🌍`);
  }
  console.log(`📡 PayOS Client ID: ${process.env.PAYOS_CLIENT_ID?.slice(0, 8)}...`);
  console.log(`✅ Sẵn sàng nhận thanh toán!\n`);
});
