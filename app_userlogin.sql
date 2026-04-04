--
-- PostgreSQL database dump
--

\restrict qBdWeeeAC3fAc8vcPMAYoZYwbhrohDymLVaiviYKm3KYoHrUZgnqTfgWo6cq4yd

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
-- Name: app_userlogin; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_userlogin (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    email public.citext NOT NULL,
    password_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    active boolean DEFAULT true NOT NULL,
    login_status public.login_status DEFAULT 'never'::public.login_status NOT NULL,
    last_login timestamp with time zone,
    failed_logins integer DEFAULT 0 NOT NULL,
    enable_bio_authentication boolean DEFAULT false NOT NULL,
    no_of_failed_login integer DEFAULT 0 NOT NULL,
    name text,
    picture text,
    is_block smallint DEFAULT 0 NOT NULL,
    role_id character varying(50) DEFAULT 'user'::character varying NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    email_verified_at timestamp with time zone,
    password_changed_date timestamp with time zone,
    login_provider text DEFAULT 'password'::text
);


--
-- Data for Name: app_userlogin; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.app_userlogin (id, user_id, email, password_hash, created_at, active, login_status, last_login, failed_logins, enable_bio_authentication, no_of_failed_login, name, picture, is_block, role_id, email_verified, email_verified_at, password_changed_date, login_provider) FROM stdin;
e57ad78f-8e6e-410a-afd4-53eb92c362f6	\N	sanosh.kushwaha53@icloud.com	$2a$10$/1q93ejb8149NulH8.5LluxlnTFRqse.ecO31jE7nlLsR0Wg1cJL6	2026-01-13 21:51:10.665557+08	t	logged_in	2026-01-17 17:18:21.214715+08	0	f	0	\N	\N	0	user	t	\N	\N	otp
8a2b21fc-f3a1-43f6-b6de-f91240f61e7d	\N	test1@example.com	dummyhash	2025-09-05 21:50:08.515657+08	t	never	\N	0	f	0	\N	\N	0	user	f	\N	\N	password
4195911f-ff19-4018-9bef-30624c8e9a7d	\N	santosh@example.com	$2b$10$tfJsPM1.puPNQ5YBU4zqueoQ3hUyFXPGqphVLsshQQHtfJHqgQvry	2025-09-05 22:06:27.39795+08	t	never	\N	0	f	0	\N	\N	0	user	f	\N	\N	password
c09c4bc0-2f05-40c9-9efb-92d1516d6b09	\N	aks@gmail.com	$2b$10$TdmeOX2r2kAInJFEP9VBrOku0jnbMO9pPDDptqYXHYadAEn43ka6m	2025-09-05 22:06:56.682729+08	t	never	\N	0	f	0	\N	\N	0	user	f	\N	\N	password
11dd1e36-0f31-432d-85c1-b01d9ce0f9b2	\N	akanshasams@gmail.com	$2a$10$vkSBCA//77bR65zUUYJAz.QyJ6vUkD6S6Hb8aIT8cDi33Zmx2NBDS	2025-11-14 22:40:53.720868+08	t	logged_in	2025-11-14 22:41:47.519407+08	0	f	0	\N	\N	0	user	f	\N	\N	password
ad07c817-9cd1-4d73-b03d-bac54a1ffa6f	\N	raju@gmail.com	$2a$10$OEgLiu3TH1/wwWShmuBmV.MlDpfs94HJ2CUSfOpan5whm8Q2hlfB6	2025-09-14 17:25:42.325102+08	t	logged_in	2025-11-15 08:47:32.312903+08	0	f	0	\N	\N	0	user	f	\N	\N	password
32c83c5f-2c21-49c6-9914-a0b32c6e3fdd	\N	manav.kushwaha45@gmail.com	\N	2025-09-10 14:54:11.231503+08	t	logged_in	2026-01-13 21:11:27.144151+08	0	f	0	\N	\N	0	user	f	\N	\N	facebook
98ebb9dd-d95b-44da-8ddd-cafa4db3e204	\N	manav@gmail.ocm	$2b$10$sCWtSjlm0zH8Zhc02Un0dO3xFVAW5PSRuGnDfeBJ0rYqNAr7ByTO.	2025-09-06 11:05:02.118465+08	t	never	\N	0	f	0	\N	\N	0	user	f	\N	\N	password
01a10501-14e8-4ca5-8d4c-839aae6b9596	\N	admin@sohumastroai.com	$2a$10$MpsrSp3GqlGxEtE9mdZ7KeIxHrkTKYw/G1OcwzlG5M/A04Sl52h2S	2025-11-14 22:36:27.136505+08	t	logged_in	2026-01-04 13:50:05.772515+08	1	f	0	\N	\N	0	admin	f	\N	2025-12-14 08:59:48.629907+08	password
272baec1-d717-469c-aa9c-fccf063d13f1	\N	test2@example.com	$2b$10$qs6hpIu80S2xsx6ArNxUG.l/eK/wsbGl.SLQFarT24JqOm6at9PXG	2025-09-05 23:04:41.761998+08	t	logged_in	2025-09-15 20:45:13.15917+08	0	f	31	\N	\N	0	user	f	\N	\N	password
e17a5c2a-3b81-456f-8bce-a9cca2e8ade8	\N	sohum@yahoo.com	$2a$10$iNr5KTjGM8/14Zh/hjOR4undBHALgLzhz1lhb7tpsHDMCThxiynly	2026-01-13 21:48:25.585976+08	t	logged_in	2026-01-13 21:49:52.935552+08	0	f	0	\N	\N	0	user	f	\N	\N	password
d9f9d595-37ac-4414-a657-41edbcb27995	\N	santosh.kushwaha53@gmail.com	$2a$10$HyviPA01yFL/xZmbJC9IyeXkobxi/Zy1xr3m9AHNYtd3hMdkBh.wC	2025-09-05 22:34:30.157496+08	t	logged_in	2026-01-18 16:01:26.719375+08	0	f	8	\N	\N	0	user	t	\N	2026-01-10 21:24:15.251242+08	otp
986faec5-fac3-41ee-bc70-6bd07ced164d	\N	s.kumar.kushwaha53@gmail.com	$2a$10$Funry43eccYI1S0IhWk5o.YfJCa4kwYAkSk/RW4usnO4SpDN2GdOm	2026-01-15 08:07:18.03724+08	t	never	\N	0	f	0	\N	\N	0	user	f	\N	\N	password
4dd12489-6be8-4fbf-8f80-9dbf02b0cf08	\N	manav@gmail.com	$2a$10$GiW3i1dKyVgi5yhaGv3x3uozhQxJRivWRG4CHZ5U1LeoYAy7z3ESC	2025-10-21 19:19:25.574152+08	t	logged_in	2025-12-13 21:42:50.473485+08	0	f	0	\N	\N	0	user	f	\N	\N	password
367d079e-9ea7-4ea6-b9c5-15cc444eb6ea	\N	sohum@gmail.com	$2b$10$SnnDkM/EUMawJmEMephaDeyQ05Ksy9PnbCGFn87rQk.XffmyE3Hvu	2025-09-06 11:36:54.183023+08	t	logged_in	2025-12-01 20:33:32.632294+08	0	f	0	\N	\N	0	user	f	\N	\N	password
803e8b3a-cef1-4d14-9d87-34361a55bec2	\N	today@gmail.com	$2a$10$fsxrR4dsg7Y0Ti1AB6y73eKzUnv5CNCGuOp6jHEbmbJhJQ6k/YKje	2025-09-10 16:53:11.506103+08	t	never	\N	0	f	0	\N	\N	0	user	f	\N	\N	password
\.


--
-- Name: app_userlogin app_userlogin_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_userlogin
    ADD CONSTRAINT app_userlogin_email_key UNIQUE (email);


--
-- Name: app_userlogin app_userlogin_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_userlogin
    ADD CONSTRAINT app_userlogin_pkey PRIMARY KEY (id);


--
-- Name: uq_app_userlogin_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_app_userlogin_email ON public.app_userlogin USING btree (email);


--
-- Name: app_userlogin fk_app_userlogin_role; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_userlogin
    ADD CONSTRAINT fk_app_userlogin_role FOREIGN KEY (role_id) REFERENCES public.app_userrole(role_id);


--
-- PostgreSQL database dump complete
--

\unrestrict qBdWeeeAC3fAc8vcPMAYoZYwbhrohDymLVaiviYKm3KYoHrUZgnqTfgWo6cq4yd

