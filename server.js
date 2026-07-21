const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://turnxclo.site.je";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

// ============================================================
// 1. CREATE PAYMENT
// ============================================================
app.post('/api/create-payment', async (req, res) => {
    try {
        const { product_name, product_price, customer_email, customer_name, shipping_address } = req.body;

        const { data: order, error } = await supabase
            .from('orders')
            .insert([{
                product_name,
                amount: product_price,
                customer_email,
                customer_name,
                shipping_address: shipping_address || 'Not provided',
                status: 'pending',
                delivery_status: 'pending'
            }])
            .select()
            .single();

        if (error) throw error;

        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email: customer_email,
                amount: product_price * 100,
                currency: 'NGN',
                metadata: { order_id: order.id },
                callback_url: `${FRONTEND_URL}/shop.html`
            })
        });

        const data = await response.json();
        if (!data.status) throw new Error(data.message);
        res.json({ payment_link: data.data.authorization_url, order_id: order.id });
    } catch (error) {
        console.error('Payment error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 2. WEBHOOK
// ============================================================
app.post('/api/webhook/paystack', async (req, res) => {
    try {
        const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(JSON.stringify(req.body)).digest('hex');
        if (hash !== req.headers['x-paystack-signature']) return res.status(401).send('Invalid signature');

        const event = req.body.event;
        const data = req.body.data;

        if (event === 'charge.success') {
            const orderId = data.metadata.order_id;
            const transactionRef = data.reference;

            await supabase.from('orders').update({ status: 'paid', transaction_ref: transactionRef }).eq('id', orderId);
            await generateInvoice(orderId);
            await sendAdminNotification(orderId);
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(500);
    }
});

// ============================================================
// 3. GENERATE INVOICE
// ============================================================
async function generateInvoice(orderId) {
    const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).single();
    if (!order) return;

    const invoiceNumber = `INV-${Date.now()}-${orderId}`;

    await supabase.from('invoices').insert([{
        order_id: orderId,
        invoice_number: invoiceNumber,
        customer_email: order.customer_email,
        customer_name: order.customer_name,
        product_name: order.product_name,
        amount: order.amount,
        status: 'paid'
    }]);

    const emailHtml = `
        <div style="font-family: Arial; max-width:600px; margin:0 auto; padding:20px; background:#0a0a0a; color:#fff; border-radius:12px;">
            <h1 style="color:#fff;">TURNXCLO</h1>
            <h2 style="color:#aaa;">Invoice #${invoiceNumber}</h2>
            <hr style="border-color:#333;">
            <p><strong>Customer:</strong> ${order.customer_name}</p>
            <p><strong>Product:</strong> ${order.product_name}</p>
            <p><strong>Amount:</strong> ₦${order.amount}</p>
            <p><strong>Address:</strong> ${order.shipping_address}</p>
            <p><strong>Status:</strong> ✅ PAID</p>
            <hr style="border-color:#333;">
            <p style="color:#aaa;">Thank you! Your fit ships in 24-48 hours.</p>
            <p style="color:#aaa;">– TURNXCLO</p>
        </div>
    `;

    await transporter.sendMail({
        from: `TURNXCLO <${EMAIL_USER}>`,
        to: order.customer_email,
        subject: `Invoice ${invoiceNumber} – TURNXCLO`,
        html: emailHtml
    });
}

async function sendAdminNotification(orderId) {
    const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).single();
    if (!order) return;

    await transporter.sendMail({
        from: `TURNXCLO <${EMAIL_USER}>`,
        to: EMAIL_USER,
        subject: `🎉 New Order – ${order.product_name}`,
        html: `<h2>New Order!</h2><p><strong>Customer:</strong> ${order.customer_name}</p><p><strong>Product:</strong> ${order.product_name}</p><p><strong>Amount:</strong> ₦${order.amount}</p><p><strong>Address:</strong> ${order.shipping_address}</p><p>✅ Payment confirmed. Ready to ship!</p>`
    });
}

// ============================================================
// 4. EDIT ORDER (FULL ADMIN CONTROL)
// ============================================================
app.put('/api/order/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { shipping_address, tracking_number, delivery_status } = req.body;

        const updates = {};
        if (shipping_address !== undefined) updates.shipping_address = shipping_address;
        if (tracking_number !== undefined) updates.tracking_number = tracking_number;
        if (delivery_status !== undefined) updates.delivery_status = delivery_status;

        const { data, error } = await supabase.from('orders').update(updates).eq('id', id).select().single();
        if (error) throw error;
        res.json({ success: true, order: data });
    } catch (error) {
        console.error('Edit order error:', error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ TURNXCLO backend running on port ${PORT}`));