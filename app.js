var jsforce = require('jsforce');
var bodyParser = require('body-parser');
var rp = require('request-promise');

var username = process.env.USERNAME;
var password = process.env.PASSWORD;
var loginUrl = process.env.LOGIN_URL | 'https://login.salesforce.com';
var kickfireKey = process.env.KICKFIRE_KEY;

var express = require('express'),
  app = express(),
  port = process.env.PORT || 3000;

var conn = new jsforce.Connection({
  loginUrl : loginUrl
});

function createLead(user, company) {
  conn.sobject("Lead").create({ 
    FirstName : user.profile.first_name, 
    LastName : user.profile.last_name,
    Email: user.profile.email,
    HasOptedOutOfEmail: true,
    LeadSource: 'Community',
    Company : company
  })
  .then(function(ret) {
    console.log("Created lead id : " + ret.id);
    createChatterMessage(ret.id);
  }, function(err) {
    return console.error(err); 
  });
}

function createContact(user, accountId) {
  conn.sobject("Contact").create({ 
    FirstName : user.profile.first_name, 
    LastName : user.profile.last_name,
    Email: user.profile.email,
    HasOptedOutOfEmail: true,
    LeadSource: 'Community',
    AccountId : accountId
  })
  .then(function(ret) {
    console.log("Created contact id : " + ret.id);
    createChatterMessage(ret.id);
  }, function(err) {
    return console.error(err); 
  });  
}

function createChatterMessage(id) {
  // TBD
}

app.use(bodyParser.json());

app.post('/', function (req, res, next) {
  var user = req.body.event.user;
  console.log("user", user);
  var domain = user.profile.email.split('@')[1];
  console.log("domain", domain);

  conn.login(username, password)
  .then(function(userInfo) {
    console.log("Logged into Salesforce as", username);

    // Search for contact/lead with matching email address
    return conn.search("FIND {"+user.profile.email+"} IN EMAIL FIELDS RETURNING Contact(Id), Lead(Id)");
  }, function(err) {
    return console.error(err); 
  })
  .then(function(ret) {
    console.log("Search results", ret.searchRecords);
    if (ret.searchRecords.length > 0) {
      contactId = ret.searchRecords[0].Id;
      console.log("Found "+ret.searchRecords[0].attributes.type+" with id", contactId);
      createChatterMessage(contactId);
    } else {
      // Check email address with Kickfire
      rp({
        uri: "https://api.kickfire.com/v2/company?website="+domain+"&key="+kickfireKey,
        json: true
      })
      .then(function(ret) {
        console.log("Kickfire results", ret);
        if (ret.status === "success" && ret.data[0].isISP === 0) {
          var company = ret.data[0].name;
          // Search for account/contact using email address domain
          conn.search("FIND {"+domain+"} IN ALL FIELDS RETURNING Account(Id, Name), Contact(Id, AccountId)")
          .then(function(ret) {
            var accountId;
            console.log("Search results", ret.searchRecords);
            // Do we have results?
            if (ret.searchRecords.length > 0) {
              // Is there an unambiguous account?
              if (ret.searchRecords[0].attributes.type == 'Account'
              && (ret.searchRecords.length == 1 || ret.searchRecords[1].attributes.type != 'Account')) {
                console.log("Found account", ret.searchRecords[0].Name);
                accountId = ret.searchRecords[0].Id;
              } else if (ret.searchRecords[0].attributes.type == 'Contact') {
                // Use first matching contact
                accountId = ret.searchRecords[0].AccountId;
              }
            }
            if (accountId) {
              console.log("Found accountId", accountId);
              createContact(user, accountId);              
            } else {
              console.log("No accountId");
              createLead(user, company);
            }
          }, function(err) {
            return console.error(err); 
          });
        } else {
          // Kickfire didn't find a match, or it's an ISP email address
          return createLead(user, "Unknown");
        }
      }, function(err) {
        return console.error(err); 
      });
    }
  }, function(err) {
    return console.error(err); 
  })
  .catch(next);
  console.log('Sending response');
  res.send('ok');
});

app.listen(port);