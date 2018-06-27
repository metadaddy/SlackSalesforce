/*
 * Copyright 2018 StreamSets Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var jsforce = require('jsforce');
var bodyParser = require('body-parser');
var rp = require('request-promise');

var username = process.env.USERNAME;
var password = process.env.PASSWORD;
var loginUrl = process.env.LOGIN_URL || 'https://login.salesforce.com';
var kickfireKey = process.env.KICKFIRE_KEY;
var slackToken = process.env.SLACK_TOKEN;
var slackOauth = process.env.SLACK_OAUTH_TOKEN;

var express = require('express'),
  app = express(),
  port = process.env.PORT || 3000;

var conn = new jsforce.Connection({
  loginUrl : loginUrl
});

var lastUserId;

function splitName(user) {
  var lastSpace = user.profile.real_name.lastIndexOf(" ");

  if (lastSpace === -1) {
    user.profile.last_name = user.profile.real_name;
  } else {
    user.profile.first_name = user.profile.real_name.substring(0, lastSpace + 1);
    user.profile.last_name = user.profile.real_name.substring(lastSpace + 1, user.profile.real_name.length);    
  }
}

function createLead(user, company) {
  splitName(user);

  conn.sobject("Lead").create({ 
    FirstName : user.profile.first_name, 
    LastName : user.profile.last_name,
    Email: user.profile.email,
    HasOptedOutOfEmail: true,
    LeadSource: 'Community',
    Company : company || 'Unknown',
    Slack_ID__c : user.id
  })
  .then(function(ret) {
    console.log("Created lead id : " + ret.id);
    chatterEntity(ret.id, "New Lead joined Community Slack as ", user);
  }, function(err) {
    return console.error(err); 
  });
}

function createContact(user, accountId, ownerId) {
  splitName(user);

  conn.sobject("Contact").create({ 
    FirstName : user.profile.first_name, 
    LastName : user.profile.last_name,
    Email: user.profile.email,
    HasOptedOutOfEmail: true,
    LeadSource: 'Community',
    AccountId : accountId,
    OwnerId: ownerId,
    Slack_ID__c : user.id
  })
  .then(function(ret) {
    console.log("Created contact id : " + ret.id);
    chatterEntity(ret.id, "New Contact joined Community Slack as ", user, ownerId);
  }, function(err) {
    return console.error(err); 
  });  
}

function chatterEntity(id, text, user, ownerId) {
  var feedItem = {
    body : {
      messageSegments : [
       {
         type : "Text",
         text : text
       },
       {
         type : "MarkupBegin",
         markupType : "Bold"
       },
       {
         type : "Text",
         text : user.profile.display_name || user.profile.real_name
       },
       {
         type : "MarkupEnd",
         markupType : "Bold"
       },
      ]
    },
    feedElementType : "FeedItem",
    subjectId : id
  };

  if (ownerId) {
    feedItem.body.messageSegments.unshift({
      "type" : "Mention",
      "id" : ownerId
    });
    feedItem.body.messageSegments[1].text = " " + feedItem.body.messageSegments[1].text;
  }

  conn.chatter.resource('/feed-elements').create(feedItem)
  .then(function (ret){
    console.log("Created feed item: " + ret.id);
  }, function (err) {
    console.error(err);
  });
}

function updateExistingEntity(id, type, user, ownerId) {
  conn.sobject(type).update({ 
    Id : id,
    Slack_ID__c : user.id
  }).then(function (ret) {
    console.log("Set Slack ID on existing ", type);
    chatterEntity(id, type+" joined Community Slack as ", user, ownerId);
  }, function (err) {
    console.error(err);
  });
}

function soslEscape(str) {
  return str.replace("+","\\+").replace("-","\\-");
}

app.use(bodyParser.json());

app.post('/', function (req, res, next) {
  if (slackToken === req.body.token) {
    console.log("Token is good");
  } else {
    console.log("Bad token: "+req.body.token);
    res.status(403).send("Unauthorized");
    return;
  }

  if (req.body.challenge) {
    // Slack verification
    console.log("Slack challenge");
    res.send(req.body.challenge);      
    return;
  }

  var user = req.body.event.user;
  console.log("user from request", user);

  if (user.id === lastUserId) {
    // Filter out duplicate request
    res.send('ok');
    return;
  }

  lastUserId = user.id;

  var domain;

  // Get user's email address - it doesn't arrive in the request!
  rp({
    uri: "https://slack.com/api/users.profile.get?token="+slackOauth+"&user="+user.id,
    json: true
  })
  .then(function(ret){
    console.log("user from API", ret);

    // For some reason, the users.profile.get response doesn't include user id!
    ret.id = user.id;

    user = ret;

    domain = user.profile.email.split('@')[1];
    console.log("domain", domain);

    // Login to Salesforce
    return conn.login(username, password);
  }, function(err) {
    return console.error(err); 
  })  
  .then(function(userInfo) {
    console.log(userInfo);
    console.log("Logged into Salesforce as", username);

    // Search for contact/lead with matching email address
    // + in email address must be escaped
    return conn.search("FIND {"+soslEscape(user.profile.email)+"} IN EMAIL FIELDS RETURNING Contact(Id, OwnerId), Lead(Id, OwnerId)");
  }, function(err) {
    return console.error(err); 
  })
  .then(function(ret) {
    console.log("Search results", ret.searchRecords);
    if (ret.searchRecords.length > 0) {
      var id = ret.searchRecords[0].Id;
      var type = ret.searchRecords[0].attributes.type;
      var ownerId = ret.searchRecords[0].OwnerId;
      console.log("Found "+type+" with id", id);
      // Is the owner a group?
      if (ownerId.startsWith('00G')) {
        // Check the type of the group
        conn.sobject('Group').retrieve(ownerId)
        .then(function(ret) {
          if (ret.Type != 'Regular') {
            // Can't mention queues etc
            ownerId = null;
          }
          updateExistingEntity(id, type, user, ownerId);
        }, function(err) {
          return console.error(err); 
        })
      } else {
        updateExistingEntity(id, type, user, ownerId);
      }
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
          conn.search("FIND {"+domain+"} IN ALL FIELDS RETURNING Account(Id, Name, OwnerId), Contact(Id, AccountId)")
          .then(function(ret) {
            var accountId;
            var ownerId;
            console.log("Search results", ret.searchRecords);
            // Do we have results?
            if (ret.searchRecords.length > 0) {
              // Is there an unambiguous account?
              if (ret.searchRecords[0].attributes.type == 'Account'
              && (ret.searchRecords.length == 1 || ret.searchRecords[1].attributes.type != 'Account')) {
                console.log("Found account", ret.searchRecords[0].Name);
                accountId = ret.searchRecords[0].Id;
                ownerId = ret.searchRecords[0].OwnerId;
                createContact(user, accountId, ownerId);
              } else if (ret.searchRecords[0].attributes.type == 'Contact') {
                // Use first matching contact
                accountId = ret.searchRecords[0].AccountId;
                // Get account owner
                conn.sobject("Account").retrieve(accountId)
                .then(function (ret) {
                  console.log("Account", ret);
                  ownerId = ret.OwnerId;
                  createContact(user, accountId, ownerId);              
                }, function (err) {
                  return console.error(err);
                });
              }
            }
            if (!accountId) {
              console.log("No accountId");
              // Couldn't find an account
              createLead(user, company);
            }
          }, function(err) {
            return console.error(err); 
          });
        } else {
          // Kickfire didn't find a match, or it's an ISP email address
          createLead(user);
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