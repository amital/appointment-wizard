import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// AI-powered: finds the next available slot based on natural language preferences
// e.g. "next Monday afternoon", "earliest possible", "Wednesday morning next week"

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const {
      business_email,
      preference, // natural language: "next Monday", "earliest", "Wednesday afternoon"
      search_days = 14, // how many days ahead to search
      count = 3, // how many options to return
    } = body;

    if (!business_email) {
      return Response.json({ error: 'Missing required field: business_email' }, { status: 400 });
    }

    const db = base44.asServiceRole.entities;

    // Get business config
    const configs = await db.BusinessConfig.filter({ email: business_email });
    if (!configs.length) {
      return Response.json({ error: 'Business not found' }, { status: 404 });
    }
    const config = configs[0];

    const tz = config.timezone || 'Asia/Jerusalem';
    const durationMin = config.appointment_duration_minutes || 60;
    const bufferMin = config.buffer_minutes || 0;
    const workingDays = config.working_days || [0, 1, 2, 3, 4];
    const startHour = config.working_hours_start || '08:00';
    const endHour = config.working_hours_end || '17:00';
    const worksOnHolidays = config.works_on_holidays || false;

    // Get blocked slots and appointments
    const blockedSlots = await db.BlockedSlot.filter({ business_email });
    const appointments = await db.Appointment.filter({ business_email });
    const holidays = await db.Holiday.filter({});

    const holidayDates = new Set(
      holidays
        .filter((h: any) => h.default_closed && !worksOnHolidays)
        .map((h: any) => h.date)
    );

    // Parse preference using simple heuristics
    const prefLower = (preference || '').toLowerCase();
    let preferredDayOfWeek: number | null = null;
    let preferredTimeRange: { start: number; end: number } | null = null;

    // Day of week hints
    const dayMap: Record<string, number> = {
      'sunday': 0, 'ראשון': 0,
      'monday': 1, 'שני': 1,
      'tuesday': 2, 'שלישי': 2,
      'wednesday': 3, 'רביעי': 3,
      'thursday': 4, 'חמישי': 4,
      'friday': 5, 'שישי': 5,
      'saturday': 6, 'שבת': 6,
    };
    for (const [dayName, dayNum] of Object.entries(dayMap)) {
      if (prefLower.includes(dayName)) {
        preferredDayOfWeek = dayNum;
        break;
      }
    }

    // Time of day hints
    if (prefLower.includes('morning') || prefLower.includes('בוקר')) {
      preferredTimeRange = { start: 8, end: 12 };
    } else if (prefLower.includes('afternoon') || prefLower.includes('אחר הצהריים') || prefLower.includes('צהריים')) {
      preferredTimeRange = { start: 12, end: 17 };
    } else if (prefLower.includes('evening') || prefLower.includes('ערב')) {
      preferredTimeRange = { start: 17, end: 21 };
    }

    const now = new Date();
    const fromDate = new Date(now);
    fromDate.setMinutes(Math.ceil(fromDate.getMinutes() / 30) * 30, 0, 0); // round up to next 30min

    const toDate = new Date(now);
    toDate.setDate(toDate.getDate() + search_days);

    const found: any[] = [];
    const cursor = new Date(fromDate);

    while (cursor <= toDate && found.length < count) {
      const dayOfWeek = cursor.getDay();
      const dateStr = cursor.toISOString().split('T')[0];

      if (workingDays.includes(dayOfWeek) && !holidayDates.has(dateStr)) {
        // Check day preference
        if (preferredDayOfWeek !== null && dayOfWeek !== preferredDayOfWeek) {
          cursor.setDate(cursor.getDate() + 1);
          cursor.setHours(0, 0, 0, 0);
          continue;
        }

        const [startH, startM] = startHour.split(':').map(Number);
        const [endH, endM] = endHour.split(':').map(Number);

        const dayStart = new Date(cursor);
        // If it's today, start from now
        if (dateStr === now.toISOString().split('T')[0]) {
          if (cursor.getHours() > startH || (cursor.getHours() === startH && cursor.getMinutes() >= startM)) {
            dayStart.setTime(cursor.getTime());
          } else {
            dayStart.setHours(startH, startM, 0, 0);
          }
        } else {
          dayStart.setHours(startH, startM, 0, 0);
        }

        // Apply time range preference
        if (preferredTimeRange) {
          if (dayStart.getHours() < preferredTimeRange.start) {
            dayStart.setHours(preferredTimeRange.start, 0, 0, 0);
          }
        }

        const dayEnd = new Date(cursor);
        dayEnd.setHours(endH, endM, 0, 0);
        if (preferredTimeRange) {
          const prefEnd = new Date(cursor);
          prefEnd.setHours(preferredTimeRange.end, 0, 0, 0);
          if (prefEnd < dayEnd) dayEnd.setTime(prefEnd.getTime());
        }

        let slotStart = new Date(dayStart);
        while (slotStart.getTime() + durationMin * 60000 <= dayEnd.getTime() && found.length < count) {
          const slotEnd = new Date(slotStart.getTime() + durationMin * 60000);

          const isBlocked = blockedSlots.some((b: any) => {
            const bStart = new Date(b.start_datetime);
            const bEnd = new Date(b.end_datetime);
            return slotStart < bEnd && slotEnd > bStart;
          });

          const isBooked = appointments.some((a: any) => {
            if (a.status === 'cancelled') return false;
            const aStart = new Date(a.start_datetime);
            const aEnd = new Date(a.end_datetime);
            return slotStart < aEnd && slotEnd > aStart;
          });

          if (!isBlocked && !isBooked) {
            found.push({
              start: slotStart.toISOString(),
              end: slotEnd.toISOString(),
              date: dateStr,
              time: slotStart.toTimeString().slice(0, 5),
              day_name: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'][dayOfWeek],
            });
          }

          slotStart = new Date(slotStart.getTime() + (durationMin + bufferMin) * 60000);
        }
      }

      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
    }

    return Response.json({
      slots: found,
      total: found.length,
      preference_applied: preference || 'earliest available',
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
