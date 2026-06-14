require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const PayOS = require("@payos/node");

const app = express();
const PORT = process.env.PORT || 3000;

const payos = new PayOS(
  process.env.PAYOS_CLIENT_ID,
  process.env.PAYOS_API_KEY,
  process.env.PAYOS_CHECKSUM_KEY
);

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());

const orderStore = new Map();

app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Laundry IoT Backend đang chạy",
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/create-payment-link", async (req, res) => {
  try {
    const { machineId, machineName, service, amount } = req.body;

    if (!machineId || !amount) {
      return res.status(400).json({
        error: "Thiếu machineId hoặc amount",
      });
    }

    const orderCode = Number(String(Date.now()).slice(-8));

    const frontendUrl =
      process.env.FRONTEND_URL ||
      "https://laundry-iot-web.kiananh123.workers.dev";

    const paymentData = {
      orderCode,
      amount: Math.round(amount),
      description: `Laundry-${machineId}`.slice(0, 25),
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

    orderStore.set(String(orderCode), {
      status: "PENDING",
      machineId,
      machineName,
      service,
      amount,
      createdAt: new Date().toISOString(),
      paymentLinkId: paymentLink.paymentLinkId,
    });

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

app.get("/api/payment-status/:orderCode", async (req, res) => {
  try {
    const { orderCode } = req.params;
    const localOrder = orderStore.get(String(orderCode));

    if (!localOrder) {
      return res.status(404).json({
        error: "Không tìm thấy đơn hàng",
      });
    }

    if (localOrder.status === "PAID") {
      return res.json({
        status: "PAID",
        orderCode,
        ...localOrder,
      });
    }

    try {
      const paymentInfo = await payos.getPaymentLinkInformation(orderCode);

      if (paymentInfo.status === "PAID") {
        localOrder.status = "PAID";
        localOrder.paidAt = new Date().toISOString();
        orderStore.set(String(orderCode), localOrder);
      }

      if (paymentInfo.status === "CANCELLED") {
        localOrder.status = "CANCELLED";
        orderStore.set(String(orderCode), localOrder);
      }

      return res.json({
        status: localOrder.status,
        orderCode,
        ...localOrder,
      });
    } catch {
      return res.json({
        status: localOrder.status,
        orderCode,
        ...localOrder,
      });
    }
  } catch (error) {
    console.error("[PayOS] Lỗi kiểm tra trạng thái:", error);
    res.status(500).json({
      error: "Lỗi kiểm tra trạng thái thanh toán",
    });
  }
});

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
    res.status(500).json({
      error: "Không thể huỷ đơn hàng",
    });
  }
});

app.post("/api/webhook", async (req, res) => {
  try {
    const webhookData = payos.verifyPaymentWebhookData(req.body);
    const { orderCode, code, desc, data } = webhookData;

    console.log(`[Webhook] Đơn #${orderCode}: ${code} - ${desc}`);

    if (code === "00") {
      const order = orderStore.get(String(orderCode));
      if (order) {
        order.status = "PAID";
        order.paidAt = new Date().toISOString();
        order.transactionId = data?.reference;
        orderStore.set(String(orderCode), order);
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error("[Webhook] Lỗi:", error);
    res.status(400).json({
      error: "Webhook không hợp lệ",
    });
  }
});

// Frontend để cuối cùng
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Backend URL: https://laundry-iot-backend.onrender.com`);
});