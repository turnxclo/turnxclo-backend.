// ============================================================
// TURNXCLO – COMPLETE BACKEND SERVER
// ============================================================

const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// ENVIRONMENT VARIABLES (You fill these in .env)
// ============================================================
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://turnxclo.66ghz.com";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// EMAIL SETUP
// ============================================================
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

// ============================================================
// 1. CREATE PAYMENT
// ============================================================
app.post('/api/create-payment', async (req, res) => {
    try {
        const {
            product_name,
            product_price,
            customer_email,
            customer_name,
            customer_phone,
            shipping_address,
            shipping_state,
            shipping_fee,
            total_amount
        } = req.body;

        const { data: order, error } = await supabase
            .from('orders')
            .insert([{
                product_name,
                amount: product_price,
                shipping_fee: shipping_fee || 0,
                total_amount: total_amount || product_price,
                customer_email,
                customer_name,
                customer_phone: customer_phone || '',
                shipping_address: shipping_address || 'Not provided',
                shipping_state: shipping_state || 'Not provided',
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
                amount: (total_amount || product_price) * 100,
                currency: 'NGN',
                metadata: { order_id: order.id },
                callback_url: `${FRONTEND_URL}/shop.html`
            })
        });

        const data = await response.json();

        if (!data.status) throw new Error(data.message);

        res.json({
            payment_link: data.data.authorization_url,
            order_id: order.id
        });

    } catch (error) {
        console.error('Payment creation error:', error);
        res.status(500).json({ error: error.message || 'Failed to create payment' });
    }
});

// ============================================================
// 2. WEBHOOK – Paystack calls this on payment confirmation
// ============================================================
app.post('/api/webhook/paystack', async (req, res) => {
    try {
        const hash = crypto
            .createHmac('sha512', PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');

        if (hash !== req.headers['x-paystack-signature']) {
            return res.status(401).send('Invalid signature');
        }

        const event = req.body.event;
        const data = req.body.data;

        if (event === 'charge.success') {
            const orderId = data.metadata.order_id;
            const transactionRef = data.reference;

            await supabase
                .from('orders')
                .update({
                    status: 'paid',
                    delivery_status: 'paid',
                    transaction_ref: transactionRef
                })
                .eq('id', orderId);

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
    try {
        const { data: order } = await supabase
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .single();

        if (!order) return;

        const invoiceNumber = `INV-${Date.now()}-${orderId}`;

        await supabase.from('invoices').insert([{
            order_id: orderId,
            invoice_number: invoiceNumber,
            customer_email: order.customer_email,
            customer_name: order.customer_name,
            product_name: order.product_name,
            amount: order.total_amount || order.amount,
            status: 'paid'
        }]);

        const emailHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; background: #0a0a0a; color: #ffffff; border-radius: 16px;">
                <h1 style="color: #ffffff; font-size: 2rem; margin-bottom: 5px;">TURNXCLO</h1>
                <h2 style="color: #aaaaaa; font-weight: 300; margin-bottom: 20px;">Invoice #${invoiceNumber}</h2>
                <hr style="border-color: #333;">
                <p><strong>Customer:</strong> ${order.customer_name}</p>
                <p><strong>Product:</strong> ${order.product_name}</p>
                <p><strong>Amount:</strong> ₦${order.total_amount || order.amount}</p>
                <p><strong>Shipping Fee:</strong> ₦${order.shipping_fee || 0}</p>
                <p><strong>Total:</strong> ₦${(order.total_amount || order.amount) + (order.shipping_fee || 0)}</p>
                <p><strong>Address:</strong> ${order.shipping_address}</p>
                <p><strong>Status:</strong> ✅ PAID</p>
                <hr style="border-color: #333;">
                <p style="color: #aaaaaa; font-size: 0.9rem;">Thank you for your purchase! Your fit will be shipped within 24-48 hours.</p>
                <p style="color: #aaaaaa; font-size: 0.9rem;">– TURNXCLO</p>
            </div>
        `;

        await transporter.sendMail({
            from: `TURNXCLO <${EMAIL_USER}>`,
            to: order.customer_email,
            subject: `Invoice ${invoiceNumber} – TURNXCLO`,
            html: emailHtml
        });

        console.log(`✅ Invoice ${invoiceNumber} sent to ${order.customer_email}`);

    } catch (error) {
        console.error('Invoice generation error:', error);
    }
}

// ============================================================
// 4. ADMIN NOTIFICATION
// ============================================================
async function sendAdminNotification(orderId) {
    try {
        const { data: order } = await supabase
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .single();

        if (!order) return;

        const emailHtml = `
            <h2>🎉 New Order!</h2>
            <p><strong>Customer:</strong> ${order.customer_name}</p>
            <p><strong>Product:</strong> ${order.product_name}</p>
            <p><strong>Amount:</strong> ₦${order.total_amount || order.amount}</p>
            <p><strong>Shipping Fee:</strong> ₦${order.shipping_fee || 0}</p>
            <p><strong>Total:</strong> ₦${(order.total_amount || order.amount) + (order.shipping_fee || 0)}</p>
            <p><strong>Address:</strong> ${order.shipping_address}</p>
            <p><strong>Status:</strong> ✅ Payment confirmed. Ready to ship!</p>
            <a href="${FRONTEND_URL}/admin.html">View in Admin Dashboard</a>
        `;

        await transporter.sendMail({
            from: `TURNXCLO <${EMAIL_USER}>`,
            to: EMAIL_USER,
            subject: `🎉 New Order – ${order.product_name}`,
            html: emailHtml
        });

        console.log(`✅ Admin notification sent for order #${orderId}`);

    } catch (error) {
        console.error('Admin notification error:', error);
    }
}

// ============================================================
// 5. EDIT ORDER (Full Admin Control)
// ============================================================
app.put('/api/order/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const {
            shipping_address,
            tracking_number,
            delivery_status,
            status,
            admin_notes
        } = req.body;

        const updates = {};
        if (shipping_address !== undefined) updates.shipping_address = shipping_address;
        if (tracking_number !== undefined) updates.tracking_number = tracking_number;
        if (delivery_status !== undefined) updates.delivery_status = delivery_status;
        if (status !== undefined) updates.status = status;
        if (admin_notes !== undefined) updates.admin_notes = admin_notes;

        const { data, error } = await supabase
            .from('orders')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, order: data });

    } catch (error) {
        console.error('Edit order error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 6. GET ORDERS (Admin)
// ============================================================
app.get('/api/orders', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('orders')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({ success: true, orders: data });

    } catch (error) {
        console.error('Get orders error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 7. GET PRODUCTS (Admin)
// ============================================================
app.get('/api/products', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('products')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.json({ success: true, products: data });

    } catch (error) {
        console.error('Get products error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 8. HEALTH CHECK
// ============================================================
app.get('/api/health', async (req, res) => {
    try {
        const { data, error } = await supabase.from('products').select('count').limit(1);
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            database: error ? 'error' : 'connected'
        });
    } catch (error) {
        res.status(500).json({
            status: 'unhealthy',
            error: error.message
        });
    }
});

// ============================================================
// 9. START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ TURNXCLO backend running on port ${PORT}`);
    console.log(`✅ Frontend URL: ${FRONTEND_URL}`);
});