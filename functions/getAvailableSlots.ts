import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// Returns available appointment slots for a business within a date range
// Takes into account: working hours, blocked slots, existing appointments, holidays

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const { business_email, date_from, date_to } = body;

    if (!business_email || !date_from || !date_to) {
      return Response.json({ error: 'Missing required fields: business_email, date_from, date_to' }, { status: 400 });
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
    const workingDays = config.working_days || [0, 1, 2, 3, 4]; // Sun-Thu default
    const startHour = config.working_hours_start || '08:00';
    const endHour = config.working_hours_end || '17:00';
    const worksOnHolidays = config.works_on_holidays || false;

    // Get blocked slots in range
    const blockedSlots = await db.BlockedSlot.filter({ business_email });

    // Get existing appointments in range
    const appointments = await db.Appointment.filter({ business_email });

    // Get holidays in range
    const holidays = await db.Holiday.filter({});

    const fromDate = new Date(date_from);
    const toDate = new Date(date_to);

    const holidayDates = new Set(
      holidays
        .filter((h: any) => h.default_closed && !worksOnHolidays)
        .map((h: any) => h.date)
    );

    const slots: any[] = [];
    const cursor = new Date(fromDate);

    while (cursor <= toDate) {
      const dayOfWeek = cursor.getDay(); // 0=Sun
      const dateStr = cursor.toISOString().split('T')[0];

      if (workingDays.includes(dayOfWeek) && !holidayDates.has(dateStr)) {
        // Build slots for this day
        const [startH, startM] = startHour.split(':').map(Number);
        const [endH, endM] = endHour.split(':').map(Number);

        const dayStart = new Date(cursor);
        dayStart.setHours(startH, startM, 0, 0);
        const dayEnd = new Date(cursor);
        dayEnd.setHours(endH, endM, 0, 0);

        let slotStart = new Date(dayStart);
        while (slotStart.getTime() + durationMin * 60000 <= dayEnd.getTime()) {
          const slotEnd = new Date(slotStart.getTime() + durationMin * 60000);

          // Check if slot overlaps with blocked slots
          const isBlocked = blockedSlots.some((b: any) => {
            const bStart = new Date(b.start_datetime);
            const bEnd = new Date(b.end_datetime);
            return slotStart < bEnd && slotEnd > bStart;
          });

          // Check if slot overlaps with existing appointments
          const isBooked = appointments.some((a: any) => {
            if (a.status === 'cancelled') return false;
            const aStart = new Date(a.start_datetime);
            const aEnd = new Date(a.end_datetime);
            return slotStart < aEnd && slotEnd > aStart;
          });

          if (!isBlocked && !isBooked) {
            slots.push({
              start: slotStart.toISOString(),
              end: slotEnd.toISOString(),
              date: dateStr,
              time: slotStart.toTimeString().slice(0, 5),
            });
          }

          slotStart = new Date(slotStart.getTime() + (durationMin + bufferMin) * 60000);
        }
      }

      cursor.setDate(cursor.getDate() + 1);
    }

    return Response.json({ slots, total: slots.length });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
