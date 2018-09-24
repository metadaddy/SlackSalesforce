@RestResource(urlMapping='/webhook')
global class SlackWebhook {
    static Slack_Salesforce__mdt settings = [SELECT Slack_Token__c, Slack_OAuth_Token__c , Kickfire_Key__c  
                                             FROM Slack_Salesforce__mdt
                                             WHERE DeveloperName = 'Slack_Salesforce'
                                             LIMIT 1];

    @HttpPost
    global static void doPost() {
        String jsonIn = RestContext.request.requestBody.toString();
        
        // Parse JSON request
        Map<String, Object> request = (Map<String, Object>)JSON.deserializeUntyped(jsonIn);
        
        RestResponse res = RestContext.response;
        
        String token = (String)request.get('token');
        String challenge = (String)request.get('challenge');
        if (! settings.Slack_Token__c.equals(token)) {
            res.statusCode = 403;
            res.responseBody = Blob.valueOf('unauthorized');
        } else if (challenge != null) {
            res.statusCode = 200;
            res.addHeader('Content-Type', 'text/plain');
            res.responseBody = Blob.valueOf(challenge);
        } else {
			execute(jsonIn);
            
            res.statusCode = 200;
            res.responseBody = Blob.valueOf('ok');
        }
    }
    
    @future (callout=true)
    public static void execute(String jsonIn) {
        Map<String, Object> request = (Map<String, Object>)JSON.deserializeUntyped(jsonIn);

        // Extract user ID
        Map<String, Object> event = (Map<String, Object>)request.get('event');
        Map<String, Object> user = (Map<String, Object>)event.get('user');
        String userId = (String)user.get('id');
        System.debug('Got Slack user ID: ' + userId);

        // Incoming event data does NOT include email address - need a callout to Slack to get it
        user = getSlackUser(userId);

        Map<String, Object> profile = (Map<String, Object>)user.get('profile');
        String email = (String)profile.get('email');

        Sobject entity = findEntityFromEmail(email);
      
        if (entity != null) {
            entity.put('Slack_ID__c', userId);
            Database.update(entity);
            
            // And... we're done!
            return;
        }
        
        // We didn't find an existing contact or lead - need to create a new one
        List<String> names = splitName((String)profile.get('real_name'));

        String domain = email.split('@')[1];
        
        Map<String, Object> company = getCompanyDataFromDomain(domain);
        
        if ((Integer)company.get('isISP') == 0) {
            Account account = findAccountFromDomain(domain);
            if (account != null) {
                // Identified an account - create a contact on it
                Contact c = new Contact(
                    FirstName = names[0], 
                    LastName = names[1], 
                    Email = (String)profile.get('email'), 
                    AccountId = account.Id,
                    OwnerId = account.OwnerId,
                    Slack_ID__c = userId
                );
                insert c;
                
                return;
            }
        }
        
        String companyName = null;
        if (company != null && (Integer)company.get('isISP') == 0) {
            companyName = (String)company.get('name');
        }

		// 3        
        // Create Lead
        Lead l = new Lead(
            FirstName = names[0], 
            LastName = names[1], 
            Email = (String)profile.get('email'), 
            Company = (companyName != null) ? companyName : 'UNKNOWN',
            Slack_ID__c = userId
        );
        insert l;
    }

    static Map<String, Object> getMapFromUrl(String url) {
		Http h = new Http();
        HttpRequest req = new HttpRequest();
		req.setEndpoint(url);
		req.setMethod('GET');

        HttpResponse res = h.send(req);
		String jsonRes = res.getBody();
        
        System.debug(jsonRes);
        
        // Parse the JSON response
        return (Map<String, Object>)JSON.deserializeUntyped(jsonRes);         
    }

	// 1    
    static Map<String, Object> getSlackUser(String userId) {
        // Make Slack URL
        String url = 'https://slack.com/api/users.profile.get?token='+settings.Slack_OAuth_Token__c+'&user='+userId;
        
        // Get user data from Slack
        return getMapFromUrl(url);
    }
    
    // 2
    static Sobject findEntityFromEmail(String email) {
        List<List<SObject>> searchList = [FIND :email IN EMAIL FIELDS 
                                          RETURNING Contact(Id, OwnerId), Lead(Id, OwnerId)];
        
        Contact [] contacts = ((List<Contact>)searchList[0]);
		Lead [] leads = ((List<Lead>)searchList[1]);
        Sobject entity = null;
        
        if (contacts.size() > 0) {
            entity = contacts[0];
        } else if (leads.size() > 0) {
            entity = leads[0];
        }
        
        return entity;
    }
    
    static Account findAccountFromDomain(String domain) {
        List<List<SObject>> searchList = [FIND :domain IN ALL FIELDS 
                                          RETURNING Account(Id, Name, OwnerId), Contact(Id, AccountId)];
        
		Account [] accounts = ((List<Account>)searchList[0]);
        Contact [] contacts = ((List<Contact>)searchList[1]);
        Account account = null;
        
        if (accounts.size() == 1) {
            account = accounts[0];
        } else if (contacts.size() > 0) {
            account = [SELECT Id, OwnerId FROM Account WHERE Id = :contacts[0].AccountId];
        }
        
        return account;
    }

    static Map<String, Object> getCompanyDataFromDomain(String domain) {
        String url = 'https://api.kickfire.com/v2/company?website='+domain+'&key='+settings.Kickfire_Key__c;
        
        // Get user data from Kickfire
        Map<String, Object> ret = getMapFromUrl(url);
        if (ret.get('status').toString() != 'success') {
            return null;
        }
        List<Object> data = (List<Object>)ret.get('data');
        return (Map<String, Object>)data[0];
    }
    
    static List<String> splitName(String name) {
        Integer lastSpace = name.lastIndexOf(' ');
        List<String> parts = new List<String>();

		if (lastSpace == -1) {
    		parts.add(null);
            parts.add(name);
		} else {
    		parts.add(name.substring(0, lastSpace + 1));
            parts.add(name.substring(lastSpace + 1));
		}
        
        return parts;
    }
}