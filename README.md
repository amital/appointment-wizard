# 🧙‍♂️ Appointment Wizard — אשף פגישות

A central scheduling superagent built on [Base44](https://base44.com), designed to be embedded in multiple apps.

## What it does

- Connects to **Google Calendar** per business
- Manages **working hours**, **blocked slots**, and **public holidays**
- Books, cancels, and reschedules appointments with AI
- Designed to be called from any Base44 app via HTTP functions

---

## Base URL

```
https://appointment-wizard-47af223f.base44.app/functions/
```

## Authentication

Every request must include a Base44 auth token:

```http
Authorization: Bearer <base44_token>
Content-Type: application/json
```

---

## Entities (Database Tables)

| Entity | Description |
|--------|-------------|
| `BusinessConfig` | Business settings: working hours, duration, Google token, AI instructions |
| `BlockedSlot` | Manual blocks: vacations, out-of-office, special closures |
| `Appointment` | Booked appointments with status and Google Calendar event ID |
| `Holiday` | Israeli & international holidays with default_closed flag |

---

## Functions

---

### 1. `updateBusinessConfig`

Registers a new business or updates an existing one.
Use this once per business to set up working hours, duration, timezone, and Google Calendar connection.

**Endpoint**
```
POST /functions/updateBusinessConfig
```

**Input**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | ✅ | Business owner email — used as the unique identifier |
| `business_name` | string | | Display name of the business |
| `business_type` | string | | One of: `clinic`, `lawyer`, `plumber`, `dentist`, `restaurant`, `other` |
| `working_days` | number[] | | Days of week: `0`=Sun, `1`=Mon, … `6`=Sat. Example: `[0,1,2,3,4]` = Sun–Thu |
| `working_hours_start` | string | | Daily start time, format `HH:MM`. Example: `"08:00"` |
| `working_hours_end` | string | | Daily end time, format `HH:MM`. Example: `"17:00"` |
| `appointment_duration_minutes` | number | | Default slot length in minutes. Example: `30` |
| `buffer_minutes` | number | | Gap between appointments in minutes. Example: `10` |
| `works_on_holidays` | boolean | | `true` = open on public holidays |
| `calendar_id` | string | | Google Calendar ID to write to. Use `"primary"` for main calendar |
| `google_refresh_token` | string | | Google OAuth refresh token for this business (for server-side calendar writes) |
| `timezone` | string | | IANA timezone. Example: `"Asia/Jerusalem"` |
| `ai_instructions` | string | | Custom instructions for the AI when handling this business |
| `command` | string | | Free-text description of what triggered this update — saved to history |

**Example Request**
```json
{
  "email": "doctor@clinic.com",
  "business_name": "קליניקת ד\"ר כהן",
  "business_type": "clinic",
  "working_days": [0, 1, 2, 3, 4],
  "working_hours_start": "08:00",
  "working_hours_end": "17:00",
  "appointment_duration_minutes": 30,
  "buffer_minutes": 10,
  "works_on_holidays": false,
  "calendar_id": "primary",
  "timezone": "Asia/Jerusalem",
  "command": "Initial setup from AppScout"
}
```

**Output**

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | `true` if operation succeeded |
| `action` | string | `"created"` or `"updated"` |
| `config` | object | The full saved BusinessConfig record |

**Example Response**
```json
{
  "success": true,
  "action": "created",
  "config": {
    "id": "abc123",
    "email": "doctor@clinic.com",
    "business_name": "קליניקת ד\"ר כהן",
    "working_days": [0, 1, 2, 3, 4],
    "working_hours_start": "08:00",
    "working_hours_end": "17:00",
    "appointment_duration_minutes": 30,
    "buffer_minutes": 10,
    "timezone": "Asia/Jerusalem",
    "created_date": "2026-03-28T00:00:00Z"
  }
}
```

---

### 2. `getAvailableSlots`

Returns all free appointment slots for a business within a given date range.
Accounts for: working hours, blocked slots, existing appointments, and public holidays.

**Endpoint**
```
POST /functions/getAvailableSlots
```

**Input**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `business_email` | string | ✅ | The business email (must exist in BusinessConfig) |
| `date_from` | string | ✅ | Start of range, format `YYYY-MM-DD` |
| `date_to` | string | ✅ | End of range, format `YYYY-MM-DD` |

**Example Request**
```json
{
  "business_email": "doctor@clinic.com",
  "date_from": "2026-03-30",
  "date_to": "2026-04-05"
}
```

**Output**

| Field | Type | Description |
|-------|------|-------------|
| `slots` | array | List of available time slots |
| `slots[].start` | string | Slot start — ISO 8601 datetime |
| `slots[].end` | string | Slot end — ISO 8601 datetime |
| `slots[].date` | string | Date of slot — `YYYY-MM-DD` |
| `slots[].time` | string | Local time of slot — `HH:MM` |
| `total` | number | Total number of available slots returned |

**Example Response**
```json
{
  "slots": [
    { "start": "2026-03-30T06:00:00.000Z", "end": "2026-03-30T06:30:00.000Z", "date": "2026-03-30", "time": "08:00" },
    { "start": "2026-03-30T06:40:00.000Z", "end": "2026-03-30T07:10:00.000Z", "date": "2026-03-30", "time": "08:40" }
  ],
  "total": 14
}
```

---

### 3. `findNextAvailable`

Finds the next available slot(s) using optional natural language preferences.
Great for AI assistants — pass what the user said and get smart results.

**Endpoint**
```
POST /functions/findNextAvailable
```

**Input**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `business_email` | string | ✅ | The business email |
| `preference` | string | | Natural language hint. See examples below |
| `search_days` | number | | How many days ahead to search. Default: `14` |
| `count` | number | | How many options to return. Default: `3` |

**Preference examples**

| Input | Behavior |
|-------|----------|
| `"earliest"` | First available slot from now |
| `"Monday morning"` | Monday slots between 08:00–12:00 |
| `"יום רביעי אחר הצהריים"` | Wednesday slots between 12:00–17:00 |
| `"Thursday evening"` | Thursday slots between 17:00–21:00 |
| `"שישי בוקר"` | Friday morning slots |
| *(empty)* | Same as "earliest" |

**Example Request**
```json
{
  "business_email": "doctor@clinic.com",
  "preference": "יום שני בוקר",
  "search_days": 14,
  "count": 3
}
```

**Output**

| Field | Type | Description |
|-------|------|-------------|
| `slots` | array | List of matching available slots |
| `slots[].start` | string | Slot start — ISO 8601 |
| `slots[].end` | string | Slot end — ISO 8601 |
| `slots[].date` | string | Date — `YYYY-MM-DD` |
| `slots[].time` | string | Local time — `HH:MM` |
| `slots[].day_name` | string | Day name in Hebrew (e.g. `"שני"`) |
| `total` | number | Number of slots returned |
| `preference_applied` | string | Echo of the preference used |

**Example Response**
```json
{
  "slots": [
    { "start": "2026-03-30T06:00:00.000Z", "end": "2026-03-30T06:30:00.000Z", "date": "2026-03-30", "time": "08:00", "day_name": "שני" },
    { "start": "2026-04-06T06:00:00.000Z", "end": "2026-04-06T06:30:00.000Z", "date": "2026-04-06", "time": "08:00", "day_name": "שני" }
  ],
  "total": 2,
  "preference_applied": "יום שני בוקר"
}
```

---

### 4. `bookAppointment`

Books an appointment for a client and optionally creates a Google Calendar event.
Checks for conflicts before booking — returns `409` if slot is taken.

**Endpoint**
```
POST /functions/bookAppointment
```

**Input**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `business_email` | string | ✅ | The business email |
| `client_name` | string | ✅ | Full name of the client |
| `start_datetime` | string | ✅ | Appointment start — ISO 8601. Example: `"2026-03-30T10:00:00"` |
| `client_email` | string | | Client email (also added as Google Calendar attendee) |
| `client_phone` | string | | Client phone number |
| `title` | string | | Appointment title. Default: `"פגישה עם {client_name}"` |
| `notes` | string | | Internal notes for the appointment |
| `booked_via` | string | | Source app identifier. Example: `"appscout"` |
| `access_token` | string | | Google OAuth access token (if not using stored refresh token) |

**Example Request**
```json
{
  "business_email": "doctor@clinic.com",
  "client_name": "ישראל ישראלי",
  "client_email": "israel@example.com",
  "client_phone": "050-1234567",
  "start_datetime": "2026-03-30T10:00:00",
  "title": "בדיקה שגרתית",
  "notes": "מטופל חדש, ללא תיק קודם",
  "booked_via": "appscout"
}
```

**Output**

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | `true` if booked successfully |
| `appointment` | object | The full saved Appointment record |
| `appointment.id` | string | Appointment ID (use for cancel/reschedule) |
| `appointment.status` | string | Always `"confirmed"` on success |
| `appointment.start_datetime` | string | Confirmed start time |
| `appointment.end_datetime` | string | Confirmed end time |
| `google_event_id` | string | Google Calendar event ID (or `null` if not synced) |

**Example Response**
```json
{
  "success": true,
  "appointment": {
    "id": "appt_xyz789",
    "business_email": "doctor@clinic.com",
    "client_name": "ישראל ישראלי",
    "client_email": "israel@example.com",
    "start_datetime": "2026-03-30T08:00:00.000Z",
    "end_datetime": "2026-03-30T08:30:00.000Z",
    "title": "בדיקה שגרתית",
    "status": "confirmed",
    "booked_via": "appscout"
  },
  "google_event_id": "gcal_event_abc"
}
```

**Error: Slot already taken**
```json
{ "error": "Time slot is no longer available" }
```
HTTP status: `409 Conflict`

---

### 5. `cancelAppointment`

Cancels an existing appointment and optionally removes the event from Google Calendar.

**Endpoint**
```
POST /functions/cancelAppointment
```

**Input**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `appointment_id` | string | ✅ | The appointment ID (from `bookAppointment` response) |
| `delete_from_calendar` | boolean | | Remove event from Google Calendar. Default: `true` |
| `access_token` | string | | Google OAuth access token (if not using stored refresh token) |

**Example Request**
```json
{
  "appointment_id": "appt_xyz789",
  "delete_from_calendar": true
}
```

**Output**

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | `true` if cancelled successfully |
| `appointment_id` | string | Echo of the cancelled appointment ID |
| `status` | string | Always `"cancelled"` on success |

**Example Response**
```json
{
  "success": true,
  "appointment_id": "appt_xyz789",
  "status": "cancelled"
}
```

**Error: Already cancelled**
```json
{ "error": "Appointment is already cancelled" }
```
HTTP status: `400 Bad Request`

---

### 6. `rescheduleAppointment`

Moves an existing appointment to a new time slot.
Checks for conflicts at the new time — returns `409` if slot is taken.
Updates the Google Calendar event automatically if one exists.

**Endpoint**
```
POST /functions/rescheduleAppointment
```

**Input**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `appointment_id` | string | ✅ | The appointment ID to reschedule |
| `new_start_datetime` | string | ✅ | New start time — ISO 8601. Example: `"2026-04-01T14:00:00"` |
| `access_token` | string | | Google OAuth access token (if not using stored refresh token) |

**Example Request**
```json
{
  "appointment_id": "appt_xyz789",
  "new_start_datetime": "2026-04-01T14:00:00"
}
```

**Output**

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | `true` if rescheduled successfully |
| `appointment_id` | string | Echo of the appointment ID |
| `new_start` | string | Confirmed new start time — ISO 8601 |
| `new_end` | string | Confirmed new end time — ISO 8601 |

**Example Response**
```json
{
  "success": true,
  "appointment_id": "appt_xyz789",
  "new_start": "2026-04-01T12:00:00.000Z",
  "new_end": "2026-04-01T12:30:00.000Z"
}
```

**Error: New slot is taken**
```json
{ "error": "New time slot is not available" }
```
HTTP status: `409 Conflict`

---

### 7. `blockSlot`

Blocks a time range for a business (vacation, lunch, out of office, etc.).
Blocked slots are excluded from all availability checks.
Optionally creates a blocking event in Google Calendar.

**Endpoint**
```
POST /functions/blockSlot
```

**Input**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `business_email` | string | ✅ | The business email |
| `start_datetime` | string | ✅ | Block start — ISO 8601 |
| `end_datetime` | string | ✅ | Block end — ISO 8601 |
| `reason` | string | | Description of the block. Example: `"חופשה"`, `"הדרכה"` |
| `is_recurring` | boolean | | `true` if this block repeats. Default: `false` |
| `recurrence_rule` | string | | RRULE string for recurring blocks. Example: `"RRULE:FREQ=WEEKLY;BYDAY=FR"` |
| `create_calendar_event` | boolean | | Create a blocking event in Google Calendar. Default: `true` |
| `access_token` | string | | Google OAuth access token (if not using stored refresh token) |

**Example Request — One-time block**
```json
{
  "business_email": "doctor@clinic.com",
  "start_datetime": "2026-04-15T00:00:00",
  "end_datetime": "2026-04-20T23:59:59",
  "reason": "חופשת פסח",
  "create_calendar_event": true
}
```

**Example Request — Recurring block (every Friday)**
```json
{
  "business_email": "doctor@clinic.com",
  "start_datetime": "2026-03-27T13:00:00",
  "end_datetime": "2026-03-27T17:00:00",
  "reason": "שישי — סגור אחר הצהריים",
  "is_recurring": true,
  "recurrence_rule": "RRULE:FREQ=WEEKLY;BYDAY=FR"
}
```

**Output**

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | `true` if block was created |
| `blocked` | object | The full saved BlockedSlot record |
| `blocked.id` | string | Block ID (use to delete later) |
| `google_event_id` | string | Google Calendar event ID (or `null`) |

**Example Response**
```json
{
  "success": true,
  "blocked": {
    "id": "block_abc123",
    "business_email": "doctor@clinic.com",
    "start_datetime": "2026-04-15T00:00:00.000Z",
    "end_datetime": "2026-04-20T23:59:59.000Z",
    "reason": "חופשת פסח",
    "is_recurring": false
  },
  "google_event_id": "gcal_block_xyz"
}
```

---

## Error Reference

| HTTP Status | Meaning |
|-------------|---------|
| `400` | Missing required field or invalid input |
| `404` | Business or appointment not found |
| `409` | Conflict — slot is already booked or blocked |
| `500` | Internal server error |

All errors return:
```json
{ "error": "Description of what went wrong" }
```

---

## Integration with AppScout

Typical flow for AppScout (or any host app):

```
1. User registers business  →  updateBusinessConfig
2. User asks for availability  →  getAvailableSlots  or  findNextAvailable
3. User picks a slot  →  bookAppointment
4. User needs to change  →  rescheduleAppointment
5. User cancels  →  cancelAppointment
6. User goes on vacation  →  blockSlot
```

The `booked_via` field in `bookAppointment` lets you track which app originated each booking.

---

## Holidays Pre-loaded

38 Israeli and international holidays loaded for 2025–2026:
- Passover, Rosh Hashana, Yom Kippur, Sukkot, Shavuot, Purim, Independence Day
- New Year's Day (international)

---

## Built with

- [Base44](https://base44.com) — backend, database, functions
- Google Calendar API
- Deno runtime (TypeScript)
