var express = require('express');
var router = express.Router();

// Students may only add offerings in the current registration term
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

/* GET Faculty role page */
router.get('/faculty/:id', function(req, res, next) {
  const userId = req.params.id;
  const db = req.app.locals.db;
  if (!db) {
    return renderErrorPage(500, 'Faculty query failed to find database', res);
  }

  // Faculty SSNs are stored without dashes, so ignore any the user typed
  const facultyQuery = 'select FacSSN as SSN, FacFirstName as "First Name", FacLastName as "Last Name", '
                     + 'FacDept as Dept, FacRank as Rank, FacHireDate as Hired, '
                     + 'FacCity as City, FacState as State, FacZipCode as Zip '
                     + 'from Faculty where FacSSN = $id;';
  const faculty = db.prepare(facultyQuery).get({ $id: digitsOnly(userId) });
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

  const rosterQuery = 'select StdSSN as SSN, StdFirstName as "First Name", StdLastName as "Last Name", '
                    + 'StdMajor as Major, StdClass as Class, EnrGrade as Grade '
                    + 'from Enrollment natural join Student '
                    + 'where OfferNo = $offerNo order by StdLastName, StdFirstName;';
  const rosterStmt = db.prepare(rosterQuery);
  const rosters = offerings.map((off) => ({
    offering: off,
    students: rosterStmt.all({ $offerNo: off.Offering })
  }));

  res.render('faculty', {
    title: `Welcome, ${faculty['First Name']} ${faculty['Last Name']}`,
    id: userId,
    faculty: faculty,
    offerings: offerings,
    rosters: rosters
  });
});

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
                        + "coalesce(FacFirstName || ' ' || FacLastName, 'TBA') as Instructor, "
                        + 'EnrGrade as Grade '
                        + 'from Enrollment natural join Offering natural join Course '
                        + 'left join Faculty using (FacSSN) '
                        + 'where StdSSN = $ssn order by OffYear, OffTerm, CourseNo;';
  const enrollments = db.prepare(enrollmentQuery).all({ $ssn: student.SSN });

  // Offerings the student could add: in the current term and not already enrolled in
  const availableQuery = 'select OfferNo as Offering, CourseNo as Course, CrsDesc as Description, '
                       + 'CrsUnits as Units, OffTerm as Term, OffYear as Year, OffDays as Days, '
                       + 'OffTime as Time, OffLocation as Location, '
                       + "coalesce(FacFirstName || ' ' || FacLastName, 'TBA') as Instructor "
                       + 'from Offering o natural join Course left join Faculty using (FacSSN) '
                       + 'where o.OffTerm = $term and o.OffYear = $year '
                       + 'and not exists (select * from Enrollment e '
                       + '                where e.StdSSN = $ssn and e.OfferNo = o.OfferNo) '
                       + 'order by CourseNo, OfferNo;';
  const available = db.prepare(availableQuery).all({ $ssn: student.SSN,
                                                     $term: CURRENT_TERM,
                                                     $year: CURRENT_YEAR });

  res.render('student', {
    title: `Welcome, ${student['First Name']} ${student['Last Name']}`,
    id: userId,
    student: student,
    enrollments: enrollments,
    available: available,
    currentTerm: `${CURRENT_TERM} ${CURRENT_YEAR}`,
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
    return redirectToStudent(res, userId, { error: `Offering ${req.body.offerNo} does not exist.` });
  }
  if (offering.OffTerm !== CURRENT_TERM || offering.OffYear !== CURRENT_YEAR) {
    return redirectToStudent(res, userId, {
      error: `Offering ${offerNo} is in ${offering.OffTerm} ${offering.OffYear}; you can only add ${CURRENT_TERM} ${CURRENT_YEAR} courses.`
    });
  }

  const enrolledQuery = 'select OfferNo from Enrollment where StdSSN = $ssn and OfferNo = $offerNo;';
  if (db.prepare(enrolledQuery).get({ $ssn: student.SSN, $offerNo: offerNo })) {
    return redirectToStudent(res, userId, { error: `You are already enrolled in offering ${offerNo}.` });
  }

  const sql = 'insert into Enrollment (OfferNo, StdSSN, EnrGrade) values ($offerNo, $ssn, null);';
  const changes = db.prepare(sql).run({ $offerNo: offerNo, $ssn: student.SSN });
  console.info(`Adding course changed ${changes.changes} row(s)`);
  redirectToStudent(res, userId, { message: `Added ${offering.CourseNo} (offering ${offerNo}).` });
});

/* POST Student drop course */
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
  const sql = 'delete from Enrollment where OfferNo = $offerNo and StdSSN = $ssn;';
  const changes = db.prepare(sql).run({ $offerNo: offerNo, $ssn: student.SSN });
  console.info(`Dropping course changed ${changes.changes} row(s)`);
  if (changes.changes === 0) {
    return redirectToStudent(res, userId, { error: `You are not enrolled in offering ${req.body.offerNo}.` });
  }
  redirectToStudent(res, userId, { message: `Dropped offering ${offerNo}.` });
});

/* GET Registrar role page */
router.get('/registrar/:id', function(req, res, next) {
  const userId = req.params.id;
  const db = req.app.locals.db;
  if (!db) {
    return renderErrorPage(500, 'Registrar query failed to find database', res);
  }

  const offeringsQuery = 'select OfferNo as Offering, CourseNo as Course, CrsDesc as Description, '
                       + 'OffTerm as Term, OffYear as Year, OffDays as Days, OffTime as Time, '
                       + 'OffLocation as Location, '
                       + "coalesce(FacFirstName || ' ' || FacLastName, 'TBA') as Instructor, "
                       + '(select count(*) from Enrollment e where e.OfferNo = Offering.OfferNo) as Enrolled '
                       + 'from Offering natural join Course left join Faculty using (FacSSN) '
                       + 'where OffTerm = $term and OffYear = $year '
                       + 'order by CourseNo, OfferNo;';
  const coursesQuery = 'select CourseNo as Course, CrsDesc as Description, CrsUnits as Units '
                     + 'from Course order by CourseNo;';
  const facultyQuery = 'select FacSSN as SSN, FacFirstName as "First Name", FacLastName as "Last Name", '
                     + 'FacDept as Dept, FacRank as Rank, FacHireDate as Hired '
                     + 'from Faculty order by FacLastName, FacFirstName;';
  const studentsQuery = 'select StdSSN as SSN, StdFirstName as "First Name", StdLastName as "Last Name", '
                      + 'StdMajor as Major, StdClass as Class, StdGPA as GPA '
                      + 'from Student order by StdLastName, StdFirstName;';

  res.render('registrar', {
    title: 'Registrar Portal',
    id: userId,
    offerings: db.prepare(offeringsQuery).all({ $term: CURRENT_TERM, $year: CURRENT_YEAR }),
    currentTerm: `${CURRENT_TERM} ${CURRENT_YEAR}`,
    courses: db.prepare(coursesQuery).all(),
    faculty: db.prepare(facultyQuery).all(),
    students: db.prepare(studentsQuery).all()
  });
});

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

// Redirect after a change so refreshing the page doesn't repeat it
function redirectToStudent(res, userId, params) {
  const query = new URLSearchParams(params).toString();
  res.redirect(`/student/${encodeURIComponent(userId)}?${query}`);
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
