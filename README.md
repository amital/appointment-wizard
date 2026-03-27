# 🧙‍♂️ Appointment Wizard — אשף פגישות

A central scheduling superagent built on [Base44](https://base44.com), designed to be embedded in multiple apps.

## What it does

- Connects to **Google Calendar** per business
- Manages **working hours**, **blocked slots**, and **public holidays**
- Books, cancels, and reschedules appointments with AI
- Designed to be called from any Base44 app via HTTP functions

---

## Architecture

### Entities (Database Tables)

| Entity | Description |
|--------|-------------|
| `BusinessConfig` | Business settings: working hours, duration, Google token, AI instructions |
| `BlockedSlot` | Manual blocks: vacations, out-of-office, special closures |
| `Appointment` | Booked appointments with status and Google Calendar event ID |
| `Holiday` | Israeli & international holidays with default_closed flag |

### Backend Functions

| Function | Method | Description |
|----------|--------|-------------|
| `getAvailableSlots` | POST | Returns all free slots in a date range |
| `findNextAvailable` | POST | AI-powered: finds next slot by natural language preference |
| `bookAppointment` | POST | Books a slot + creates Google Calendar event |
| `cancelAppointment` | POST | Cancels appointment + removes from calendar |
| `rescheduleAppointment` | POST | Moves appointment to new time |
| `blockSlot` | POST | Blocks a time range + adds blocking event to calendar |
| `updateBusinessConfig` | POST | Creates or updates business settings |

---

## Base URL

```
https://appointment-wizard-47af223f.base44.app/functions/
```

---

## Function Reference

### `updateBusinessConfig`
Register or update a business.

```json
{
  "email": "doctor@clinic.com",
  "business_name": "קליניקה ד\"ר כהן",
  "business_type": "clinic",
  "working_days": [0, 1, 2, 3, 4],
  "working_hours_start": "08:00",
  "working_hours_end": "17:00",
  "appointment_duration_minutes": 30,
  "buffer_minutes": 10,
  "works_on_holidays": false,
  "calendar_id": "primary",
  "google_refresh_token": "...",
  "timezone": "Asia/Jerusalem",
  "command": "initial setup"
}
```

---

### `getAvailableSlots`
Get all free slots in a date range.

```json
{
  "business_email": "doctor@clinic.com",
  "date_from": "2026-03-30",
  "date_to": "2026-04-05"
}
```

**Response:**
```json
{
  "slots": [
    { "start": "2026-03-30T08:00:00Z", "end": "2026-03-30T08:30:00Z", "date": "2026-03-30", "time": "10:00" }
  ],
  "total": 12
}
```

---

### `findNextAvailable`
Find next available slot with optional natural language preference.

```json
{
  "business_email": "doctor@clinic.com",
  "preference": "יום שני בוקר",
  "search_days": 14,
  "count": 3
}
```

**Preference examples:** `"earliest"`, `"Monday morning"`, `"יום רביעי אחר הצהריים"`, `"Thursday evening"`

---

### `bookAppointment`
Book an appointment and create a Google Calendar event.

```json
{
  "business_email": "doctor@clinic.com",
  "client_name": "ישראל ישראלי",
  "start_datetime": "2026-03-30T10:00:00",
  "client_email": "client@email.com",
  "client_phone": "050-1234567",
  "title": "בדיקה שגרתית",
  "notes": "מטופל חדש",
  "booked_via": "appscout",
  "access_token": "ya29...."
}
```

---

### `cancelAppointment`
Cancel and optionally remove from Google Calendar.

```json
{
  "appointment_id": "abc123",
  "delete_from_calendar": true,
  "access_token": "ya29...."
}
```

---

### `rescheduleAppointment`
Move appointment to a new time.

```json
{
  "appointment_id": "abc123",
  "new_start_datetime": "2026-04-01T14:00:00",
  "access_token": "ya29...."
}
```

---

### `blockSlot`
Block a time range (vacation, out of office, etc.)

```json
{
  "business_email": "doctor@clinic.com",
  "start_datetime": "2026-04-02T10:00:00",
  "end_datetime": "2026-04-02T13:00:00",
  "reason": "מחוץ למשרד",
  "is_recurring": false,
  "create_calendar_event": true,
  "access_token": "ya29...."
}
```

---

## Authentication

All function calls require a Base44 auth token in the header:

```
Authorization: Bearer <base44_token>
```

---

## Integration with AppScout

AppScout (or any Base44 app) can call these functions directly with:
1. A valid Base44 service token
2. The business email as identifier
3. Optionally, a Google access token for calendar writes

---

## Holidays Pre-loaded

38 Israeli and international holidays loaded for 2025–2026:
- Passover, Rosh Hashana, Yom Kippur, Sukkot, Shavuot, Independence Day, Purim
- New Year's Day (international)

---

## Built with

- [Base44](https://base44.com) — backend, database, functions
- Google Calendar API
- Deno runtime (TypeScript)
