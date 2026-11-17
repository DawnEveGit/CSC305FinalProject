var express = require('express');
var router = express.Router();

// The upcoming term: students register for it and the registrar schedules it
const CURRENT_TERM = 'WINTER';
const CURRENT_YEAR = 2026;

/* GET home page: ID and role selection form */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'Portal Login' });
});

/* POST login: route based on chosen role */
router.post('/login', function(req, res, next) {
  const userId = req.body.userId;
  const role = req.body.role;

  if (!userId || !role) {
    return res.render('index', {
      title: 'Portal Login',
      error: 'Please enter an ID and select a role.'
    });
  }

  // Redirect to role-specific page
  if (role === 'faculty') {
    res.redirect(`/faculty/${encodeURIComponent(userId)}`);
  } else if (role === 'student') {
    res.redirect(`/student/${encodeURIComponent(userId)}`);
  } else if (role === 'registrar') {
    res.redirect(`/registrar/${encodeURIComponent(userId)}`);
  } else {
    res.redirect('/');
  }
});

/* ------------------------------------------------------------------ */
/* Faculty                                                             */
/* ------------------------------------------------------------------ */

/* GET Faculty role page: offerings taught, each with a link to edit grades */
router.get('/faculty/:id', function(req, res, next) {
  const userId = req.params.id;
  const db = req.app.locals.db;
  if (!db) {
    return renderErrorPage(500, 'Faculty query failed to find database', res);
  }

  const faculty = findFaculty(db, userId);
  if (!faculty) {
    return renderLoginError(`No faculty member with ID ${userId}`, res);
  }

  const offeringsQuery = 'select OfferNo as Offering, CourseNo as Course, CrsDesc as Description, '
                       + 'OffTerm as Term, OffYear as Year, OffDays as Days, OffTime as Time, '
                       + 'OffLocation as Location, count(StdSSN) as Enrolled '
                       + 'from Offering natural join Course left join Enrollment using (OfferNo) '
                       + 'where FacSSN = $id '
                       + 'group by OfferNo order by OffYear, OffTerm, CourseNo;';
  const offerings = db.prepare(offeringsQuery).all({ $id: faculty.SSN });

  res.render('faculty', {
    title: `Welcome, ${faculty['First Name']} ${faculty['Last Name']}`,
    id: userId,
    faculty: faculty,
    offerings: offerings,
    message: req.query.message,
    error: req.query.error
  });
});

/* GET grade editing page for one offering taught by this faculty member */
router.get('/faculty/:id/grades/:offerNo', function(req, res, next) {
  const userId = req.params.id;
  const db = req.app.locals.db;
  if (!db) {
    return renderErrorPage(500, 'Grade query failed to find database', res);
  }

  const faculty = findFaculty(db, userId);
  if (!faculty) {
    return renderLoginError(`No faculty member with ID ${userId}`, res);
  }
  const offering = findTaughtOffering(db, faculty, req.params.offerNo);
  if (!offering) {
    return redirectWith(res, facultyUrl(userId),
      { error: `You do not teach offering ${req.params.offerNo}.` });
  }

  res.render('grades', {
    title: `Grades for ${offering.Course} (Offering ${offering.Offering})`,
    id: userId,
    faculty: faculty,
    offering: offering,
    students: getRoster(db, offering.Offering),
    message: req.query.message,
    error: req.query.error
  });
});

/* POST updated grades for one offering */
router.post('/faculty/:id/grades/:offerNo', function(req, res, next) {
  const userId = req.params.id;
  const db = req.app.locals.db;
  if (!db) {
    return renderErrorPage(500, 'Grade update failed to find database', res);
  }

  const faculty = findFaculty(db, userId);
  if (!faculty) {
    return renderLoginError(`No faculty member with ID ${userId}`, res);
  }
  const offering = findTaughtOffering(db, faculty, req.params.offerNo);
  if (!offering) {
    return redirectWith(res, facultyUrl(userId),
      { error: `You do not teach offering ${req.params.offerNo}.` });
  }
  const gradesUrl = `${facultyUrl(userId)}/grades/${offering.Offering}`;

  // Only look at students actually enrolled in this offering, so a forged
  // form field can't change some other enrollment
  const roster = getRoster(db, offering.Offering);
  const updates = [];
  const problems = [];
  for (const std of roster) {
    const raw = req.body[`grade_${std['Student ID']}`];
    if (raw === undefined) {
      continue;
    }
    const grade = parseGrade(raw);
    if (grade === undefined) {
      problems.push(`${std['Student Name']} ("${raw}")`);
    } else {
      updates.push({ ssn: std['Student ID'], grade: grade });
    }
  }
  if (problems.length > 0) {
    return redirectWith(res, gradesUrl, {
      error: 'Grades must be blank or a number from 0.0 to 4.0. No grades were saved. '
           + 'Check: ' + problems.join(', ')
    });
  }

  // "is not" treats null like a value, so unchanged grades (even blank ones) are skipped
  const sql = 'update Enrollment set EnrGrade = $grade '
            + 'where OfferNo = $offerNo and StdSSN = $ssn and EnrGrade is not $grade;';
  const stmt = db.prepare(sql);
  let changed = 0;
  try {
    inTransaction(db, () => {
      for (const u of updates) {
        changed += stmt.run({ $grade: u.grade, $offerNo: offering.Offering, $ssn: u.ssn }).changes;
      }
    });
  } catch (err) {
    console.error(err);
    return redirectWith(res, gradesUrl, { error: `Could not save grades: ${err.message}` });
  }
  console.info(`Grade update changed ${changed} row(s)`);
  redirectWith(res, gradesUrl, {
    message: changed === 0 ? 'No grades were changed.'
                           : `Saved ${changed} grade change${changed === 1 ? '' : 's'}.`
  });
});

/* ------------------------------------------------------------------ */
/* Student                                                             */
/* ------------------------------------------------------------------ */

/* GET Student role page */
router.get('/student/:id', function(req, res, next) {
  const userId = req.params.id;
  const db = req.app.locals.db;
  if (!db) {
    return renderErrorPage(500, 'Student query failed to find database', res);
  }

  const student = findStudent(db, userId);
  if (!student) {
    return renderLoginError(`No student with ID ${userId}`, res);
  }

  const enrollmentQuery = 'select OfferNo as Offering, CourseNo as Course, CrsDesc as Description, '
                        + 'CrsUnits as Units, OffTerm as Term, OffYear as Year, OffDays as Days, '
                        + 'OffTime as Time, OffLocation as Location, '
                        + "coalesce(FacFirstName || ' ' || FacLastName, '') as Instructor, "
                        + 'EnrGrade as Grade '
                        + 'from Enrollment natural join Offering natural join Course '
                        + 'left join Faculty using (FacSSN) '
                        + 'where StdSSN = $ssn order by OffYear, OffTerm, CourseNo;';
  const enrollments = db.prepare(enrollmentQuery).all({ $ssn: student.SSN });

  // Every offering in the upcoming term, marked with whether it's already in the schedule
  const upcomingQuery = 'select OfferNo as Offering, CourseNo as Course, CrsDesc as Description, '
                      + 'CrsUnits as Units, '
                      + "coalesce(FacFirstName || ' ' || FacLastName, '') as Instructor, "
                      + 'OffLocation as Location, OffTime as Time, OffDays as Days, '
                      + 'case when exists (select * from Enrollment e '
                      + '                  where e.StdSSN = $ssn and e.OfferNo = o.OfferNo) '
                      + "     then 'Yes' else 'No' end as \"In Schedule\" "
                      + 'from Offering o natural join Course left join Faculty using (FacSSN) '
                      + 'where o.OffTerm = $term and o.OffYear = $year '
                      + 'order by CourseNo, OfferNo;';
  const upcoming = db.prepare(upcomingQuery).all({ $ssn: student.SSN,
                                                   $term: CURRENT_TERM,
                                                   $year: CURRENT_YEAR });

  res.render('student', {
    title: `Welcome, ${student['First Name']} ${student['Last Name']}`,
    id: userId,
    student: student,
    enrollments: enrollments,
    upcoming: upcoming,
    currentTerm: CURRENT_TERM,
    currentYear: CURRENT_YEAR,
    message: req.query.message,
    error: req.query.error
  });
});

/* POST Student add course */
router.post('/student/:id/add', function(req, res, next) {
  const userId = req.params.id;
  const db = req.app.locals.db;
  if (!db) {
    return renderErrorPage(500, 'Add course failed to find database', res);
  }
  const student = findStudent(db, userId);
  if (!student) {
    return renderLoginError(`No student with ID ${userId}`, res);
  }

  const offerNo = parseInt(req.body.offerNo, 10);
  const offering = db.prepare('select OfferNo, CourseNo, OffTerm, OffYear from Offering '
                              + 'where OfferNo = $offerNo;').get({ $offerNo: offerNo });
  if (!offering) {
    return redirectWith(res, studentUrl(userId), { error: `Offering ${req.body.offerNo} does not exist.` });
  }
  if (!isCurrentTerm(offering)) {
    return redirectWith(res, studentUrl(userId), {
      error: `Offering ${offerNo} is in ${offering.OffTerm} ${offering.OffYear}; you can only add ${CURRENT_TERM} ${CURRENT_YEAR} courses.`
    });
  }

  const enrolledQuery = 'select OfferNo from Enrollment where StdSSN = $ssn and OfferNo = $offerNo;';
  if (db.prepare(enrolledQuery).get({ $ssn: student.SSN, $offerNo: offerNo })) {
    return redirectWith(res, studentUrl(userId), { error: `You are already enrolled in offering ${offerNo}.` });
  }

  const sql = 'insert into Enrollment (OfferNo, StdSSN, EnrGrade) values ($offerNo, $ssn, null);';
  const changes = db.prepare(sql).run({ $offerNo: offerNo, $ssn: student.SSN });
  console.info(`Adding course changed ${changes.changes} row(s)`);
  redirectWith(res, studentUrl(userId), { message: `Added ${offering.CourseNo} (offering ${offerNo}).` });
});

/* POST Student drop course (upcoming term only; past enrollments are part of the record) */
router.post('/student/:id/drop', function(req, res, next) {
  const userId = req.params.id;
  const db = req.app.locals.db;
  if (!db) {
    return renderErrorPage(500, 'Drop course failed to find database', res);
  }
  const student = findStudent(db, userId);
  if (!student) {
    return renderLoginError(`No student with ID ${userId}`, res);
  }

  // Only delete this student's enrollment, never anyone else's
  const offerNo = parseInt(req.body.offerNo, 10);
  const sql = 'delete from Enrollment where OfferNo = $offerNo and StdSSN = $ssn '
            + 'and OfferNo in (select OfferNo from Offering where OffTerm = $term and OffYear = $year);';
  const changes = db.prepare(sql).run({ $offerNo: offerNo, $ssn: student.SSN,
                                        $term: CURRENT_TERM, $year: CURRENT_YEAR });
  console.info(`Dropping course changed ${changes.changes} row(s)`);
  if (changes.changes === 0) {
    return redirectWith(res, studentUrl(userId), {
      error: `You are not enrolled in a ${CURRENT_TERM} ${CURRENT_YEAR} offering ${req.body.offerNo}.`
    });
  }
  redirectWith(res, studentUrl(userId), { message: `Dropped offering ${offerNo}.` });
});

/* ------------------------------------------------------------------ */
/* Registrar                                                           */
/* ------------------------------------------------------------------ */

/* GET Registrar role page */
router.get('/registrar/:id', function(req, res, next) {
  const userId = req.params.id;
  const db = req.app.locals.db;
  if (!db) {
    return renderErrorPage(500, 'Registrar query failed to find database', res);
  }

  const offeringsQuery = 'select OfferNo, CourseNo, CrsDesc, FacSSN, OffLocation, OffTime, OffDays, '
                       + "coalesce(FacFirstName || ' ' || FacLastName, '') as Instructor, "
                       + '(select count(*) from Enrollment e where e.OfferNo = o.OfferNo) as Enrolled '
                       + 'from Offering o natural join Course left join Faculty using (FacSSN) '
                       + 'where OffTerm = $term and OffYear = $year '
                       + 'order by CourseNo, OfferNo;';
  const offerings = db.prepare(offeringsQuery).all({ $term: CURRENT_TERM, $year: CURRENT_YEAR })
    .map((o) => ({ ...o, OffTime: toTimeInput(o.OffTime) }));

  const coursesQuery = 'select CourseNo, CrsDesc, CrsUnits from Course order by CourseNo;';
  const facultyQuery = 'select FacSSN as SSN, FacFirstName as "First Name", FacLastName as "Last Name", '
                     + 'FacDept as Dept, FacRank as Rank, FacHireDate as Hired '
                     + 'from Faculty order by FacLastName, FacFirstName;';
  const studentsQuery = 'select StdSSN as SSN, StdFirstName as "First Name", StdLastName as "Last Name", '
                      + 'StdMajor as Major, StdClass as Class, StdGPA as GPA '
                      + 'from Student order by StdLastName, StdFirstName;';
  const nextOfferNo = db.prepare('select coalesce(max(OfferNo), 0) + 1 as next from Offering;').get().next;
  const dayPatterns = db.prepare("select distinct OffDays from Offering where OffDays <> '' "
                                 + 'order by OffDays;').all().map((r) => r.OffDays);

  res.render('registrar', {
    title: 'Registrar Portal',
    id: userId,
    offerings: offerings,
    currentTerm: `${CURRENT_TERM} ${CURRENT_YEAR}`,
    courses: db.prepare(coursesQuery).all(),
    faculty: db.prepare(facultyQuery).all(),
    students: db.prepare(studentsQuery).all(),
    nextOfferNo: nextOfferNo,
    dayPatterns: dayPatterns,
    message: req.query.message,
    error: req.query.error
  });
});

/* POST Registrar add a new offering in the upcoming term */
router.post('/registrar/:id/offering/add', function(req, res, next) {
  const userId = req.params.id;
  const db = req.app.locals.db;
  if (!db) {
    return renderErrorPage(500, 'Add offering failed to find database', res);
  }
  const back = registrarUrl(userId);

  const offerNo = parseOfferNo(req.body.offerNo);
  if (offerNo === undefined) {
    return redirectWith(res, back, { error: 'Offering number must be a whole number from 1 to 32767.' });
  }
  if (db.prepare('select OfferNo from Offering where OfferNo = $offerNo;').get({ $offerNo: offerNo })) {
    return redirectWith(res, back, { error: `Offering number ${offerNo} is already in use.` });
  }
  const course = db.prepare('select CourseNo from Course where CourseNo = $courseNo;')
    .get({ $courseNo: req.body.courseNo || '' });
  if (!course) {
    return redirectWith(res, back, { error: 'Please select a course from the course list.' });
  }
  const fields = parseOfferingFields(db, req.body);
  if (fields.error) {
    return redirectWith(res, back, { error: fields.error });
  }

  const sql = 'insert into Offering (OfferNo, CourseNo, OffTerm, OffYear, OffLocation, OffTime, FacSSN, OffDays) '
            + 'values ($offerNo, $courseNo, $term, $year, $location, $time, $facSSN, $days);';
  try {
    db.prepare(sql).run({
      $offerNo: offerNo, $courseNo: course.CourseNo, $term: CURRENT_TERM, $year: CURRENT_YEAR,
      $location: fields.location, $time: fields.time, $facSSN: fields.facSSN, $days: fields.days
    });
  } catch (err) {
    console.error(err);
    return redirectWith(res, back, { error: `Could not add offering: ${err.message}` });
  }
  console.info(`Added offering ${offerNo}`);
  redirectWith(res, back, { message: `Added ${course.CourseNo} as offering ${offerNo}.` });
});

/* POST Registrar edit an upcoming-term offering */
router.post('/registrar/:id/offering/:offerNo/update', function(req, res, next) {
  const userId = req.params.id;
  const db = req.app.locals.db;
  if (!db) {
    return renderErrorPage(500, 'Edit offering failed to find database', res);
  }
  const back = registrarUrl(userId);

  const offering = findCurrentOffering(db, req.params.offerNo);
  if (!offering) {
    return redirectWith(res, back,
      { error: `Offering ${req.params.offerNo} is not scheduled for ${CURRENT_TERM} ${CURRENT_YEAR}.` });
  }
  const fields = parseOfferingFields(db, req.body);
  if (fields.error) {
    return redirectWith(res, back, { error: `Offering ${offering.OfferNo}: ${fields.error}` });
  }

  const sql = 'update Offering set FacSSN = $facSSN, OffLocation = $location, '
            + 'OffTime = $time, OffDays = $days where OfferNo = $offerNo;';
  try {
    db.prepare(sql).run({
      $facSSN: fields.facSSN, $location: fields.location, $time: fields.time,
      $days: fields.days, $offerNo: offering.OfferNo
    });
  } catch (err) {
    console.error(err);
    return redirectWith(res, back, { error: `Could not update offering: ${err.message}` });
  }
  console.info(`Updated offering ${offering.OfferNo}`);
  redirectWith(res, back, { message: `Updated ${offering.CourseNo} (offering ${offering.OfferNo}).` });
});

/* POST Registrar cancel an upcoming-term offering */
router.post('/registrar/:id/offering/:offerNo/cancel', function(req, res, next) {
  const userId = req.params.id;
  const db = req.app.locals.db;
  if (!db) {
    return renderErrorPage(500, 'Cancel offering failed to find database', res);
  }
  const back = registrarUrl(userId);

  const offering = findCurrentOffering(db, req.params.offerNo);
  if (!offering) {
    return redirectWith(res, back,
      { error: `Offering ${req.params.offerNo} is not scheduled for ${CURRENT_TERM} ${CURRENT_YEAR}.` });
  }

  // SQLite doesn't enforce the schema's "on delete cascade" unless foreign keys
  // are turned on, so remove the offering's enrollments explicitly
  let dropped = 0;
  try {
    inTransaction(db, () => {
      dropped = db.prepare('delete from Enrollment where OfferNo = $offerNo;')
        .run({ $offerNo: offering.OfferNo }).changes;
      db.prepare('delete from Offering where OfferNo = $offerNo;').run({ $offerNo: offering.OfferNo });
    });
  } catch (err) {
    console.error(err);
    return redirectWith(res, back, { error: `Could not cancel offering: ${err.message}` });
  }
  console.info(`Canceled offering ${offering.OfferNo}, removing ${dropped} enrollment(s)`);
  redirectWith(res, back, {
    message: `Canceled ${offering.CourseNo} (offering ${offering.OfferNo})`
           + (dropped > 0 ? ` and removed ${dropped} enrollment${dropped === 1 ? '' : 's'}.` : '.')
  });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function digitsOnly(id) {
  return String(id).replace(/\D/g, '');
}

// Student SSNs are stored with dashes, so compare digits only
function findStudent(db, userId) {
  const studentQuery = 'select StdSSN as SSN, StdFirstName as "First Name", StdLastName as "Last Name", '
                     + 'StdMajor as Major, StdClass as Class, StdGPA as GPA, '
                     + 'StdCity as City, StdState as State, StdZip as Zip '
                     + "from Student where replace(StdSSN, '-', '') = $id;";
  return db.prepare(studentQuery).get({ $id: digitsOnly(userId) });
}

// Faculty SSNs are stored without dashes, so ignore any the user typed
function findFaculty(db, userId) {
  const facultyQuery = 'select FacSSN as SSN, FacFirstName as "First Name", FacLastName as "Last Name", '
                     + 'FacDept as Dept, FacRank as Rank, FacHireDate as Hired, '
                     + 'FacCity as City, FacState as State, FacZipCode as Zip '
                     + 'from Faculty where FacSSN = $id;';
  return db.prepare(facultyQuery).get({ $id: digitsOnly(userId) });
}

// An offering, but only if this faculty member teaches it
function findTaughtOffering(db, faculty, offerNo) {
  const sql = 'select OfferNo as Offering, CourseNo as Course, CrsDesc as Description, '
            + 'OffTerm as Term, OffYear as Year '
            + 'from Offering natural join Course where OfferNo = $offerNo and FacSSN = $ssn;';
  return db.prepare(sql).get({ $offerNo: parseInt(offerNo, 10), $ssn: faculty.SSN });
}

function getRoster(db, offerNo) {
  const sql = "select StdFirstName || ' ' || StdLastName as \"Student Name\", StdSSN as \"Student ID\", "
            + 'EnrGrade as Grade '
            + 'from Enrollment natural join Student '
            + 'where OfferNo = $offerNo order by StdLastName, StdFirstName;';
  return db.prepare(sql).all({ $offerNo: offerNo });
}

// An offering, but only if it's in the upcoming term
function findCurrentOffering(db, offerNo) {
  const sql = 'select OfferNo, CourseNo from Offering '
            + 'where OfferNo = $offerNo and OffTerm = $term and OffYear = $year;';
  return db.prepare(sql).get({ $offerNo: parseInt(offerNo, 10), $term: CURRENT_TERM, $year: CURRENT_YEAR });
}

function isCurrentTerm(offering) {
  return offering.OffTerm === CURRENT_TERM && offering.OffYear === CURRENT_YEAR;
}

// Blank means no grade (null). Otherwise a number from 0 to 4. Returns undefined if invalid.
function parseGrade(raw) {
  const text = String(raw).trim();
  if (text === '') {
    return null;
  }
  if (!/^\d*\.?\d+$/.test(text)) {
    return undefined;
  }
  const grade = Number(text);
  return grade >= 0 && grade <= 4 ? grade : undefined;
}

// OfferNo is a SMALLINT
function parseOfferNo(raw) {
  const text = String(raw || '').trim();
  if (!/^\d+$/.test(text)) {
    return undefined;
  }
  const n = Number(text);
  return n >= 1 && n <= 32767 ? n : undefined;
}

// Validate instructor, location, time, and days from an add or edit form.
// Blank fields are stored as null.
function parseOfferingFields(db, body) {
  const facSSN = String(body.facSSN || '').trim() || null;
  if (facSSN && !db.prepare('select FacSSN from Faculty where FacSSN = $ssn;').get({ $ssn: facSSN })) {
    return { error: 'Please choose an instructor from the list.' };
  }

  const location = String(body.location || '').trim().toUpperCase() || null;
  if (location && location.length > 50) {
    return { error: 'Location must be 50 characters or fewer.' };
  }

  let time = String(body.time || '').trim() || null;
  if (time) {
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
      return { error: 'Time must look like HH:MM (24-hour).' };
    }
    time = `${match[1].padStart(2, '0')}:${match[2]}:00`;
  }

  const days = String(body.days || '').replace(/\s/g, '').toUpperCase() || null;
  if (days && !/^(M|TH|T|W|F|SA|SU|S)+$/.test(days)) {
    return { error: 'Days must be made of M, T, W, TH, F, S (for example MW or TTH).' };
  }
  if (days && days.length > 6) {
    return { error: 'Days must be 6 characters or fewer.' };
  }

  return { facSSN, location, time, days };
}

// <input type="time"> needs HH:MM, but some stored times look like 8:30:00
function toTimeInput(time) {
  const match = /^(\d{1,2}):(\d{2})/.exec(time || '');
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : '';
}

function inTransaction(db, work) {
  db.exec('begin;');
  try {
    work();
    db.exec('commit;');
  } catch (err) {
    db.exec('rollback;');
    throw err;
  }
}

function studentUrl(userId) {
  return `/student/${encodeURIComponent(userId)}`;
}

function facultyUrl(userId) {
  return `/faculty/${encodeURIComponent(userId)}`;
}

function registrarUrl(userId) {
  return `/registrar/${encodeURIComponent(userId)}`;
}

// Redirect after a change so refreshing the page doesn't repeat it
function redirectWith(res, url, params) {
  const query = new URLSearchParams(params).toString();
  res.redirect(`${url}?${query}`);
}

function renderLoginError(msg, res) {
  res.status(404).render('index', {
    title: 'Portal Login',
    error: msg
  });
}

function renderErrorPage(code, msg, res) {
  res.status(code).render('error', {
    message: msg,
    error: {
      status: code,
      stack: null
    }
  });
}

module.exports = router;
