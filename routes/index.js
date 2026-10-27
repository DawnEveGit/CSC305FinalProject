var express = require('express');
var router = express.Router();

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
  res.render('faculty', { 
    title: 'Faculty Portal', 
    id: userId 
  });
});

/* GET Student role page */
router.get('/student/:id', function(req, res, next) {
  const userId = req.params.id;
  res.render('student', { 
    title: 'Student Portal', 
    id: userId 
  });
});

/* GET Registrar role page */
router.get('/registrar/:id', function(req, res, next) {
  const userId = req.params.id;
  res.render('registrar', { 
    title: 'Registrar Portal', 
    id: userId 
  });
});

module.exports = router;