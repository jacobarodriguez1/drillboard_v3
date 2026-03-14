CACC Drill Board

A real-time drill competition and roster management platform built with Next.js and TypeScript.

Designed for structured competition environments requiring synchronized state, multi-role access, and broadcast-ready visibility.

🚀 Overview

CACC Drill Board is a real-time web platform that provides:

Live competition area (pad) management

Dynamic roster import and assignment

Real-time synchronization via WebSockets

Role-based operational interfaces (Admin / Judge / Public)

Persistent communication channels between Admin and Judges

Structured scheduling with global and per-pad events

Soft ETA modeling and cycle tracking

Audit logging of system actions

Broadcast-optimized public display mode

The system is built for environments where timing precision, queue control, and high-visibility coordination are critical.

🏗 Tech Stack

Next.js

React

TypeScript

Node.js

Socket.IO (WebSockets)

REST API routes

CSV-based roster ingestion

ESLint

Modular component architecture

🧠 Core Capabilities
Real-Time Board State

Pad-based queue management (NOW / ON DECK / STANDBY)

Status states: REPORTING, ON_PAD, RUNNING, HOLD, BREAK, LATE

Global break control

Local pad break control

Live timer updates

Role-Based Interfaces

Public View

Broadcast-ready competition display

Visual status hierarchy

Schedule and global state visibility

Judge View

Operational controls (ARRIVED, COMPLETE, SWAP, DNS, DQ, HOLD)

Local break control

Live chat with Admin (pad-based channel)

Admin View

Dynamic pad creation and management

Queue manipulation (swap, demote, insert)

Roster reload

Global message & break controls

Persistent Admin ↔ Judge communication

Urgent message acknowledgment tracking

📡 Communication System

Pad-based Admin ↔ Judge chat channels

Urgent message flagging

Judge acknowledgment tracking

Persistent state with atomic write protection

Debounced disk persistence

📁 Project Structure

components/ → Shared UI components and layout system
lib/ → Core state logic, persistence, socket utilities
pages/ → Application routes and API endpoints
public/ → Static assets
styles/ → Global styling and design tokens
data/ → Roster CSV (excluded from persistence state)

🔐 API Endpoints

/api/state – Returns current board state
/api/socket – WebSocket handler (live sync + comm system)
/api/admin-login – Admin authentication
/api/admin-logout
/api/reload-roster – Rebuild state from CSV

💡 Architectural Highlights

Dynamic pad system (not hardcoded 1–8)

Safe state sanitization on load

Type-safe socket handlers

Atomic persistence pattern (tmp → rename)

Luminance-based UI hierarchy system

Separation of display, operational, and control modes

🛠 Local Development

npm install
npm run dev

Visit:
http://localhost:3000

📈 Roadmap

Database-backed persistence

Stronger authentication enforcement

Expanded audit reporting

Deployment automation (Vercel / Docker)

Permission refinement

Metrics dashboard