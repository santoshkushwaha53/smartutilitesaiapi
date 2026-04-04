--
-- PostgreSQL database dump
--

\restrict 6n5Qjs4TlWS2sYjMQFKIv5OQ9Sx0sG1w8l0sR2hiIKyOVt4pw5vobanE1JO0Zr7

-- Dumped from database version 17.6 (Postgres.app)
-- Dumped by pg_dump version 17.6 (Postgres.app)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: email_template; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_template (
    template_code text NOT NULL,
    name text NOT NULL,
    subject_tpl text NOT NULL,
    html_tpl text NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Data for Name: email_template; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.email_template (template_code, name, subject_tpl, html_tpl, is_enabled, created_at, updated_at) FROM stdin;
CONTACT_SUPPORT_TO_SUPPORT	Contact -> Support inbox	[Contact] {{subject}} — {{email}}	<div style="font-family:Arial,sans-serif;line-height:1.6">\n  <h2>New Contact Request</h2>\n  <p><b>Name:</b> {{name}}</p>\n  <p><b>Email:</b> {{email}}</p>\n  <p><b>Subject:</b> {{subject}}</p>\n  <p><b>Message:</b></p>\n  <pre style="white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:8px">{{message}}</pre>\n  <p style="color:#666;margin-top:14px">Received at: {{now}}</p>\n</div>	t	2025-12-13 06:41:20.337998+08	2025-12-13 06:41:20.337998+08
CONTACT_SUPPORT_ACK_USER	Contact -> Auto-ack to user	We received your message — SohumAstro AI	<div style="font-family:Arial,sans-serif;line-height:1.8">\n  <p>Hi {{name}},</p>\n  <p>Thanks for contacting <b>SohumAstro AI</b>.</p>\n  <p>We’ve received your message and our support team will get back to you within <b>24 hours</b>.</p>\n  <p style="margin-top:14px"><b>Your message:</b></p>\n  <pre style="white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:8px">{{message}}</pre>\n  <p style="margin-top:16px">Warm regards,<br/>SohumAstro AI Support</p>\n</div>	t	2025-12-13 06:41:20.337998+08	2025-12-13 06:41:20.337998+08
WELCOME	Welcome email	Welcome to SohumAstro AI, {{name}} ✨	<div style="font-family:Arial,sans-serif;line-height:1.8">\n  <h2 style="margin:0 0 8px 0">Welcome, {{name}} ✨</h2>\n  <p>We’re excited to have you on your cosmic journey.</p>\n  <p>Start exploring: <a href="{{appUrl}}">{{appUrl}}</a></p>\n  <p style="color:#666">If you didn’t create this account, please contact support.</p>\n  <p>— SohumAstro AI Support</p>\n</div>	t	2025-12-13 06:41:20.337998+08	2025-12-13 06:41:20.337998+08
LOGIN_OTP	Login OTP	Your SohumAstro AI login code: {{otp}}	<div style="font-family:Arial,sans-serif;line-height:1.8">\n  <p>Hi {{name}},</p>\n  <p>Your one-time login code is:</p>\n  <div style="font-size:26px;font-weight:700;letter-spacing:3px;margin:10px 0">{{otp}}</div>\n  <p style="color:#666">This code expires in {{expiresMinutes}} minutes.</p>\n  <p>If you didn’t request this code, please secure your account immediately.</p>\n</div>	t	2025-12-13 06:41:20.337998+08	2025-12-13 06:41:20.337998+08
PASSWORD_RESET	Password reset	Reset your SohumAstro AI password	<div style="font-family:Arial,sans-serif;line-height:1.8">\n  <p>Hi {{name}},</p>\n  <p>We received a request to reset your password.</p>\n  <p>\n    <a href="{{resetUrl}}" style="display:inline-block;padding:10px 16px;border-radius:10px;background:#2b6cff;color:#fff;text-decoration:none">\n      Reset Password\n    </a>\n  </p>\n  <p style="color:#666">This link expires in {{expiresHours}} hours.</p>\n  <p>If you didn’t request this, you can ignore this email.</p>\n</div>	t	2025-12-13 06:41:20.337998+08	2025-12-13 06:41:20.337998+08
PASSWORD_CHANGED	Password changed	Your SohumAstro AI password was changed	<div style="font-family:Arial,sans-serif;line-height:1.8">\n  <p>Hi {{name}},</p>\n  <p>This is a confirmation that your password was changed.</p>\n  <p style="color:#666">If this wasn’t you, please contact support immediately.</p>\n  <p>— SohumAstro AI Support</p>\n</div>	t	2025-12-13 06:41:20.337998+08	2025-12-13 06:41:20.337998+08
BILLING_RECEIPT	Billing receipt	Receipt: {{planName}} — {{amount}} {{currency}}	<div style="font-family:Arial,sans-serif;line-height:1.8">\n  <h2 style="margin:0 0 8px 0">Payment Receipt</h2>\n  <p>Hi {{name}},</p>\n  <p>Thanks for your purchase!</p>\n  <table style="border-collapse:collapse;width:100%;max-width:520px">\n    <tr><td style="padding:6px 0;color:#666">Invoice</td><td style="padding:6px 0"><b>{{invoiceNo}}</b></td></tr>\n    <tr><td style="padding:6px 0;color:#666">Plan</td><td style="padding:6px 0"><b>{{planName}}</b></td></tr>\n    <tr><td style="padding:6px 0;color:#666">Amount</td><td style="padding:6px 0"><b>{{amount}} {{currency}}</b></td></tr>\n    <tr><td style="padding:6px 0;color:#666">Date</td><td style="padding:6px 0">{{purchaseDate}}</td></tr>\n  </table>\n  <p style="margin-top:14px;color:#666">Need help? Contact us at support@sohumastroai.com</p>\n</div>	t	2025-12-13 06:41:20.337998+08	2025-12-13 06:41:20.337998+08
VERIFY_EMAIL	Email verification	Verify your email for SohumAstro AI	<div style="font-family:Arial,sans-serif;line-height:1.8">\n  <p>Hi {{name}},</p>\n\n  <p>\n    Your email verification code for <b>SohumAstroAI</b> is:\n  </p>\n\n  <div\n    style="\n      margin:14px 0 18px;\n      padding:14px 16px;\n      border-radius:12px;\n      background:#0f1b3a;\n      border:1px solid rgba(43,108,255,.35);\n      text-align:center;\n    "\n  >\n    <div style="font-size:12px;color:#a8b3d1;letter-spacing:.12em;text-transform:uppercase;">\n      Verification OTP\n    </div>\n\n    <div\n      style="\n        margin-top:6px;\n        font-size:28px;\n        font-weight:700;\n        letter-spacing:.35em;\n        color:#ffffff;\n      "\n    >\n      {{otp}}\n    </div>\n\n    <div style="margin-top:10px;font-size:12px;color:#a8b3d1;">\n      Expires in {{expiresMinutes}} minutes\n    </div>\n  </div>\n\n  <p style="margin:0 0 8px;">\n    Enter this OTP in the app to verify your email and unlock personalized insights.\n  </p>\n\n  <p style="color:#666;margin:0;">\n    If you didn’t request this code, you can ignore this email.\n  </p>\n</div>\n	t	2025-12-13 06:41:20.337998+08	2025-12-14 15:16:49.627687+08
SUPPORT_TICKET_CREATED_USER	Support ticket created (user ack)	We received your support request (Ticket {{ticketNo}})	<p>Hi {{userEmail}},</p>\n   <p>Thank you for contacting SohumAstro AI support. Your ticket has been created in our system.</p>\n   <p>\n     <strong>Ticket No:</strong> {{ticketNo}}<br/>\n     <strong>Issue Type:</strong> {{issueType}}<br/>\n     <strong>Summary:</strong> {{summary}}\n   </p>\n   <p>Our team will review your request and get back to you as soon as possible.</p>\n   <p>With gratitude,<br/>SohumAstro AI Support</p>	t	2026-01-18 14:48:28.252988+08	2026-01-18 15:12:01.78179+08
\.


--
-- Name: email_template email_template_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_template
    ADD CONSTRAINT email_template_pkey PRIMARY KEY (template_code);


--
-- Name: email_template trg_email_template_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_email_template_updated_at BEFORE UPDATE ON public.email_template FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- PostgreSQL database dump complete
--

\unrestrict 6n5Qjs4TlWS2sYjMQFKIv5OQ9Sx0sG1w8l0sR2hiIKyOVt4pw5vobanE1JO0Zr7

