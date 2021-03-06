/* Copyright 2014 Alexander Oberegger

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License. */

var ERR = require("ep_etherpad-lite/node_modules/async-stacktrace");
var express = require('express');
var eejs = require('ep_etherpad-lite/node/eejs');
var padManager = require('ep_etherpad-lite/node/db/PadManager');
var db = require('ep_etherpad-lite/node/db/DB').db;
var groupManager = require('ep_etherpad-lite/node/db/GroupManager');
var Changeset = require('ep_etherpad-lite/static/js/Changeset');
var mysql = require('mysql');
var email = require('emailjs');
var settings = require('ep_etherpad-lite/node/utils/Settings');
var authorManager = require('ep_etherpad-lite/node/db/AuthorManager');
var sessionManager = require('ep_etherpad-lite/node/db/SessionManager');
var formidable = require("formidable");
var crypto = require('crypto');
var eMailAuth = require(__dirname + '/email.json');
var pkg = require('./package.json');

var DEBUG_ENABLED = false;

/*
 *  Common Utility Functions
 */
var log = function (type, message) {
    if (typeof message == 'string') {
        if (type == 'error') {
            console.error(pkg.name + ': ' + message);
        } else if (type == 'debug') {
            if (DEBUG_ENABLED) {
                console.log('(debug) ' + pkg.name + ': ' + message);
            }
        } else {
            console.log(pkg.name + ': ' + message);
        }
    }
    else console.log(message);
};

var mySqlErrorHandler = function (err) {
    log('debug', 'mySqlErrorHandler');
    // TODO: Review error handling
    var msg;
    if (fileName in err && lineNumber in err) {
        msg = 'MySQLError in ' + err.fileName + ' line ' + err.lineNumber + ': ';
    } else {
        msg = 'MySQLError: ';
    }
    if (err.fatal) {
        msg += '(FATAL) ';
    }
    msg += err.message;
    log('error', msg);
};

var connectFkt = function (err) {
    if (err) {
        log('error', "failed connecting to database");
    } else {
        log('info', "connected");
    }
};

var encryptPassword = function (password, salt, cb) {
    var encrypted = crypto.createHmac('sha256', salt).update(password).digest('hex');
    cb(encrypted);
};

var USER_EXISTS = 'User already Exists';
var PASSWORD_WRONG = 'Passwords do not agree';

var NO_VALID_MAIL = 'No valid E-Mail';
var PW_EMPTY = 'Password is empty';

var dbAuth = settings.dbSettings;
var dbAuthParams = {
    host: dbAuth.host,
    user: dbAuth.user,
    password: dbAuth.password,
    database: dbAuth.database,
    insecureAuth: true,
    stringifyObjects: true
};

function getRandomNum(lbound, ubound) {
    return (Math.floor(Math.random() * (ubound - lbound)) + lbound);
}

function getRandomChar(number, lower, upper, other, extra) {
    var numberChars = '0123456789';
    var lowerChars = 'abcdefghijklmnopqrstuvwxyz';
    var upperChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    var otherChars = '`~!@#$%^&*()-_=+[{]}\\|;:\'",<.>/? ';
    var charSet = extra;
    if (number == true)
        charSet += numberChars;
    if (lower == true)
        charSet += lowerChars;
    if (upper == true)
        charSet += upperChars;
    if (other == true)
        charSet += otherChars;
    return charSet.charAt(getRandomNum(0, charSet.length));
}

function createSalt(cb) {
    var mylength = 10;
    var myextraChars = '';
    var myfirstNumber = true;
    var myfirstLower = true;
    var myfirstUpper = true;
    var myfirstOther = false;
    var mylatterNumber = true;
    var mylatterLower = true;
    var mylatterUpper = true;
    var mylatterOther = false;

    var rc = "";
    if (mylength > 0) {
        rc += getRandomChar(myfirstNumber, myfirstLower, myfirstUpper, myfirstOther, myextraChars);
    }
    for (var idx = 1; idx < mylength; ++idx) {
        rc += getRandomChar(mylatterNumber, mylatterLower, mylatterUpper, mylatterOther, myextraChars);
    }
    cb(rc);

}

function getPassword(cb) {
    var mylength = 40;
    var myextraChars = '';
    var myfirstNumber = true;
    var myfirstLower = true;
    var myfirstUpper = true;
    var myfirstOther = false;
    var mylatterNumber = true;
    var mylatterLower = true;
    var mylatterUpper = true;
    var mylatterOther = false;

    var rc = "";
    if (mylength > 0) {
        rc += getRandomChar(myfirstNumber, myfirstLower, myfirstUpper, myfirstOther, myextraChars);
    }
    for (var idx = 1; idx < mylength; ++idx) {
        rc += getRandomChar(mylatterNumber, mylatterLower, mylatterUpper, mylatterOther, myextraChars);
    }
    cb(rc);
}

var connection = mysql.createConnection(dbAuthParams);
var connection2 = mysql.createConnection(dbAuthParams);
connection.connect(connectFkt);
connection2.connect(connectFkt);


var userAuthenticated = function (req, cb) {
    log('debug', 'userAuthenticated');
    if (req.session.username && req.session.password && req.session.userId && req.session.email) {
        cb(true);
    } else {
        cb(false);
    }
};

var userAuthentication = function (username, password, cb) {
    log('debug', 'userAuthentication');
    var userSql = "Select * from User where User.name = ?";
    var sent = false;
    var userFound = false;
    var considered = false;
    var active = true;
    var queryUser = connection.query(userSql, [username]);
    queryUser.on('error', mySqlErrorHandler);
    queryUser.on('result', function (foundUser) {
        userFound = true;
        encryptPassword(password, foundUser.salt, function (encrypted) {
            if (foundUser.pwd == encrypted && foundUser.considered && foundUser.active) {
                sent = true;
                cb(true, foundUser, null, considered);
            } else if (!foundUser.active) {
                active = false;
            }
            else {
                considered = foundUser.considered;
            }
        });
    });
    queryUser.on('end', function () {
        if (!sent) {
            cb(false, null, userFound, considered, active);
        }
    });
};

function existValueInDatabase(sql, params, cb) {
    log('debug', 'existValueInDatabase');
    connection.query(sql, params, function (err, found) {
        if (err) {
            log('error', 'existValueInDatabase error, sql: ' + sql);
            cb(false);
        } else if (!found || found.length == 0) {
            cb(false);
        } else {
            cb(true);
        }
    });
}

function getOneValueSql(sql, params, cb) {
    log('debug', 'getOneValueSql');
    var qry = connection.query(sql, params, function (err, found) {
        if (err) {
            log('error', 'getOneValueSql error, sql: ' + sql);
            cb(false);
        } else if (!found || found.length == 0) {
            cb(false, null);
        } else {
            cb(true, found);
        }
    });
    qry.on('error', mySqlErrorHandler)
}

function updateSql(sqlUpdate, params, cb) {
    log('debug', 'updateSql');
    var updateQuery = connection.query(sqlUpdate, params);
    updateQuery.on('error', mySqlErrorHandler);
    updateQuery.on('end', function () {
        cb(true);
    });
}

function getAllSql(sql, params, cb) {
    log('debug', 'getAllSql');
    var allInstances = [];
    var queryInstances = connection.query(sql, params);
    queryInstances.on('error', mySqlErrorHandler);
    queryInstances.on('result', function (foundInstance) {
        connection.pause();
        allInstances.push(foundInstance);
        connection.resume();
    });
    queryInstances.on('end', function () {
        cb(allInstances);
    });
}

function getUser(userId, cb) {
    log('debug', 'getUser');
    var sql = "Select * from User where userID = ?";
    getOneValueSql(sql, [userId], cb);
}

function getGroup(groupId, cb) {
    log('debug', 'getGroup');
    var sql = "Select * from Groups where groupID = ?";
    getOneValueSql(sql, [groupId], cb);
}

function getUserGroup(groupId, userId, cb) {
    log('debug', 'getUserGroup');
    var sql = "Select * from UserGroup where groupID = ? and userID = ?";
    getOneValueSql(sql, [groupId, userId], cb);
}

function getEtherpadGroupFromNormalGroup(id, cb) {
    log('debug', 'getEtherpadGroupFromNormalGroup');
    var getMapperSql = "Select * from store where store.key = ?";
    var getMapperQuery = connection2.query(getMapperSql, ["mapper2group:" + id]);
    getMapperQuery.on('error', mySqlErrorHandler);
    getMapperQuery.on('end', function () {
        log('debug', 'getEtherpadGroupFromNormalGroup getMapperQuery end');
    });
    getMapperQuery.on('result', function (mapper) {
        log('debug', 'getEtherpadGroupFromNormalGroup getMapperQuery result');
        cb(mapper.value.replace(/"/g, ''));
    });
}

function getPadsOfGroup(id, padname, cb) {
    log('debug', 'getPadsOfGroup');
    var allPads = [];
    var allSql = "Select * from GroupPads where GroupPads.GroupID = ? and GroupPads.PadName like ?";
    var queryPads = connection.query(allSql, [id, "%" + padname + "%"]);
    queryPads.on('error', mySqlErrorHandler);
    queryPads.on('result', function (foundPads) {
        log('debug', 'getPadsOfGroup result');
        connection.pause();
        var pad = {};
        pad.name = foundPads.PadName;
        log('debug', 'padname ' + pad.name);
        if (pad.name != "") {
            getEtherpadGroupFromNormalGroup(id, function (group) {
                log('debug', 'getEtherpadGroupFromNormalGroup cb');
                padManager.getPad(group + "$" + pad.name, null, function (err, origPad) {
                    if (err) log('error', err);
                    pad.isProtected = origPad.isPasswordProtected();
                    origPad.getLastEdit(function (err, lastEdit) {
                        pad.lastedit = converterPad(lastEdit);
                        allPads.push(pad);
                        connection.resume();
                    });
                });
            });
        } else {
            connection.resume();
        }
    });
    queryPads.on('end', function () {
        cb(allPads);
    });
}

var converter = function (UNIX_timestamp) {
    var a = new Date(UNIX_timestamp);
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var year = a.getFullYear();
    var month = months[a.getMonth()];
    var date = a.getDate();
    var hour = (( a.getHours() < 10) ? "0" : "") + a.getHours();
    var min = ((a.getMinutes() < 10) ? "0" : "") + a.getMinutes();
    var sec = ((a.getSeconds() < 10) ? "0" : "") + a.getSeconds();
    return date + '. ' + month + ' ' + year + ' ' + hour + ':' + min + ':' + sec;
};

var converterPad = function (UNIX_timestamp) {
    var a = new Date(UNIX_timestamp);
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var year = a.getFullYear();
    var month = months[a.getMonth()];
    var date = a.getDate();
    var hour = (( a.getHours() < 10) ? "0" : "") + a.getHours();
    var min = ((a.getMinutes() < 10) ? "0" : "") + a.getMinutes();
    return date + '. ' + month + ' ' + year + ' ' + hour + ':' + min;
};


function addUserToEtherpad(userName, cb) {
    log('debug', 'addUserToEtherpad');
    authorManager.createAuthorIfNotExistsFor(userName, null, function (err, author) {
        if (err) {
            log('error', 'something went wrong while creating author');
            cb();
        } else {
            cb(author);
        }
    });
}

function addPadToEtherpad(padName, groupId, cb) {
    log('debug', 'addPadToEtherpad');
    getEtherpadGroupFromNormalGroup(groupId, function (group) {
        groupManager.createGroupPad(group, padName, function (err) {
            if (err) {
                log('error', 'something went wrong while adding a group pad');
                cb()
            } else {
                cb();
            }
        });
    });
}

function deleteGroupFromEtherpad(id, cb) {
    getEtherpadGroupFromNormalGroup(id, function (group) {
        groupManager.deleteGroup(group, function (err) {
            if (err) {
                log('error', 'Something went wrong while deleting group from etherpad');
                cb();
            } else {
                var sql = "DELETE FROM store where store.key = ?";
                var updateQuery = connection2.query(sql, ["mapper2group:" + id]);
                updateQuery.on('error', mySqlErrorHandler);
                updateQuery.on('end', function () {
                    cb();
                });
            }
        });
    });
}


var deletePadFromEtherpad = function (name, groupid, cb) {
    getEtherpadGroupFromNormalGroup(groupid, function (group) {
        padManager.removePad(group + "$" + name);
        cb();
    });
};

function sendError(error, res) {
    var data = {};
    data.success = false;
    data.error = error;
    log('error', error);
    res.send(data);
}

exports.expressCreateServer = function (hook_name, args, cb) {
    function notRegisteredUpdate(userid, groupid, email) {
        var userGroupSql = "INSERT INTO UserGroup VALUES(?, ?, 2)";
        updateSql(userGroupSql, [userid, groupid], function (success) {
            if (success) {
                var deleteNotRegisteredSql = "DELETE FROM NotRegisteredUsersGroups where groupID = ? and email = ?";
                updateSql(deleteNotRegisteredSql, [groupid, email], function (success) {
                });
            }
        });
    }

    function checkInvitations(email, userid, cb) {
        var userNotRegisteredSql = "select * from NotRegisteredUsersGroups where email = ?";
        var notRegistereds = [];
        var queryInstances = connection2.query(userNotRegisteredSql, [email]);
        queryInstances.on('error', mySqlErrorHandler);
        queryInstances.on('result', function (foundInstance) {
            connection2.pause();
            notRegistereds.push(foundInstance);
            connection2.resume();
        });
        queryInstances.on('end', function () {
            if (notRegistereds.length < 1) {
                cb();
            }
            for (var i = 0; i < notRegistereds.length; i++) {
                notRegisteredUpdate(userid, notRegistereds[i].groupID, email);
                if ((i + 1) == notRegistereds.length)
                    cb();
            }
        });
    }

    var registerUser = function (user, cb) {
        if (user.password != user.passwordrepeat) {
            cb(false, PASSWORD_WRONG);
            return false; // break execution early
        }

        var Ergebnis = user.email.toString().match(/[a-zA-Z0-9._-]+@[a-zA-Z0-9-]+.[a-zA-Z]{2,4}/);
        if (Ergebnis == null) {
            cb(false, NO_VALID_MAIL);
            return false; // break execution early
        }
        if (user.password == "") {
            cb(false, PW_EMPTY);
            return false; // break execution early
        }
        var existUser = "SELECT * from User where User.name = ?";
        var retValue = existValueInDatabase(existUser, [user.email], function (exists) {
            if (exists) {
                cb(false, USER_EXISTS);
            } else {
                getPassword(function (consString) {
                    var msg = eMailAuth.registrationtext;
                    var loc = user.location.replace(/:\/$/, '/')
                    msg = msg.replace(/<url>/, loc + "confirm/" + consString)
                    var message = {
                        text: msg,
                        from: eMailAuth.registrationfrom,
                        to: user.email + " <" + user.email + ">",
                        subject: eMailAuth.registrationsubject
                    };

                    var nodemailer = require('nodemailer');
                    var transport = nodemailer.createTransport("sendmail");
                    if (eMailAuth.smtp == "false")
                        transport.sendMail(message);
                    else {
                        emailserver.send(message, function (err) {
                            if (err) {
                                log('error', err);
                            }
                        });
                    }
                    createSalt(function (salt) {
                        encryptPassword(user.password, salt, function (encrypted) {
                            var addUserSql = "INSERT INTO User VALUES(null, ?,?, 0, 0, ?,?,?,1)";
                            var addUserQuery = connection.query(addUserSql, [user.email, encrypted, user.fullname, consString, salt]);
                            addUserQuery.on('error', mySqlErrorHandler);
                            addUserQuery.on('result', function (newUser) {
                                connection.pause();
                                checkInvitations(user.email, newUser.insertId, function () {
                                    addUserToEtherpad(newUser.insertId, function () {
                                        connection.resume();
                                    });
                                });

                            });
                            addUserQuery.on('end', function () {
                                cb(true, null);
                            });
                        });
                    });
                });
            }
            return exists;
        });
        return retValue; // return status of function call
    };

    var emailserver = email.server.connect({
        user: eMailAuth.user,
        password: eMailAuth.password,
        host: eMailAuth.host,
        port: eMailAuth.port,
        ssl: eMailAuth.ssl
    });

    args.app.get('/index.html', function (req, res) {
        userAuthenticated(req, function (authenticated) {
            if (authenticated) {
                res.redirect('home.html'); // ../home.html
            } else {
                var render_args = {
                    errors: [],
                    username: req.session.username
                };
                res.send(eejs
                    .require("ep_user_pad_frontend/templates/index.ejs",
                        render_args));
            }
        });
    });

    args.app.get('/help.html', function (req, res) {
        userAuthenticated(req, function (authenticated) {
            if (authenticated) {
                getUser(req.session.userId, function (found, currUser) {
                    var render_args;
                    if (currUser && currUser.length > 0) {
                        render_args = {
                            errors: [],
                            username: currUser[0].FullName
                        };
                        res.send(eejs
                            .require("ep_user_pad_frontend/templates/help.ejs",
                                render_args));
                    } else {
                        render_args = {
                            errors: [],
                            username: ""
                        };
                        res.send(eejs
                            .require("ep_user_pad_frontend/templates/help.ejs",
                                render_args));
                    }
                });

            } else {
                res.redirect("../index.html");
            }
        });
    });

    args.app.get('/home.html', function (req, res) {
        userAuthenticated(req, function (authenticated) {
            if (authenticated) {
                var sql = "Select Groups.* from Groups inner join UserGroup on(UserGroup.groupID = Groups.groupID) where UserGroup.userID = ?";
                getAllSql(sql, [req.session.userId], function (groups) {
                    getUser(req.session.userId, function (found, currUser) {
                        var render_args;
                        if (currUser) {
                            render_args = {
                                errors: [],
                                username: currUser[0].FullName,
                                groups: groups
                            };
                            res.send(eejs
                                .require("ep_user_pad_frontend/templates/home.ejs",
                                    render_args));
                        } else {
                            render_args = {
                                errors: [],
                                username: " ",
                                groups: groups
                            };
                            res.send(eejs
                                .require("ep_user_pad_frontend/templates/home.ejs",
                                    render_args));
                        }
                    });
                });
            } else {
                res.redirect("../index.html");
            }
        });
    });


    args.app.get('/pads.html', function (req, res) {
        userAuthenticated(req, function (authenticated) {
            if (authenticated) {
                getUser(req.session.userId, function (found, currUser) {
                    if (currUser) {
                        var render_args = {
                            errors: [],
                            username: currUser[0].FullName
                        };
                        res.send(eejs
                            .require("ep_user_pad_frontend/templates/pads.ejs",
                                render_args));
                    }
                });
            } else {
                res.redirect("../index.html");
            }
        });
    });

    args.app.get('/group.html/:groupid', function (req, res) {
        log('debug', req.path);
        userAuthenticated(req, function (authenticated) {
            log('debug', req.path + 'userAuthenticated CB');
            if (authenticated) {
                log('debug', req.path + 'Authenticated');
                getPadsOfGroup(req.params.groupid, '', function (pads) {
                    log('debug', req.path + 'getPadsOfGroup CB');
                    getUser(req.session.userId, function (found, currUser) {
                        log('debug', req.path + 'getUser CB');
                        getGroup(req.params.groupid, function (found, currGroup) {
                            log('debug', req.path + 'getGroup CB');
                            getUserGroup(req.params.groupid, req.session.userId, function (found, currUserGroup) {
                                log('debug', req.path + 'getUserGroup CB');
                                var render_args;
                                if (!currUserGroup) {
                                    render_args = {
                                        errors: [],
                                        msg: "This group does not exist! Perhaps someone has deleted the group."
                                    };
                                    res.send(eejs
                                        .require("ep_user_pad_frontend/templates/msgtemplate.ejs",
                                            render_args));
                                    return;
                                }
                                var isown = currUserGroup[0].Role == 1;
                                if (currGroup && currUser && currUserGroup) {
                                    render_args = {
                                        errors: [],
                                        id: currGroup[0].name,
                                        groupid: currGroup[0].groupID,
                                        username: currUser[0].FullName,
                                        isowner: isown,
                                        pads: pads
                                    };
                                    res.send(eejs.require("ep_user_pad_frontend/templates/group.ejs", render_args));
                                } else {
                                    render_args = {
                                        errors: [],
                                        msg: "This group does not exist! Perhabs anyone has deleted the group."
                                    };
                                    res.send(eejs.require("ep_user_pad_frontend/templates/msgtemplate.ejs",
                                        render_args));
                                }
                            });
                        });
                    });

                });
            } else {
                res.redirect("../../index.html");
            }
        });
    });

    args.app.get('/groups.html', function (req, res) {
        userAuthenticated(req, function (authenticated) {
            if (authenticated) {
                var sql = "Select * from Groups inner join UserGroup on(UserGroup.groupID = Groups.groupID) where UserGroup.userID = ?";
                getAllSql(sql, [req.session.userId], function (groups) {
                    getUser(req.session.userId, function (found, currUser) {
                        var render_args = {
                            errors: [],
                            username: currUser[0].FullName,
                            groups: groups
                        };

                        res.send(eejs.require("ep_user_pad_frontend/templates/groups.ejs", render_args));
                    });

                });
            } else {
                res.redirect("../index.html");
            }
        });
    });

    args.app.post('/padSearchTerm', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            userAuthenticated(req, function (authenticated) {
                if (authenticated) {
                    var data = {};
                    if (!fields.groupId) {
                        var error = 'Group Id undefined';
                        sendError(error, res);
                        return;
                    }
                    getPadsOfGroup(fields.groupId, fields.searchterm, function (pads) {
                        getUser(req.session.userId, function (found, currUser) {
                            getGroup(fields.groupId, function (found, currGroup) {
                                if (currUser && currGroup) {
                                    var noresults = pads.length <= 0;
                                    var render_args = {
                                        errors: [],
                                        noresults: noresults,
                                        pads: pads,
                                        id: currGroup[0].name,
                                        groupid: currGroup[0].groupID,
                                        username: currUser[0].FullName
                                    };
                                    data.success = true;
                                    data.html = eejs.require("ep_user_pad_frontend/templates/padtables.ejs", render_args);
                                    res.send(data);
                                }
                            });
                        });
                    });

                } else {
                    res.send("You are not logged in!!");
                }

            });
        });
    });

    args.app.post('/groupsSearchTerm', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            userAuthenticated(req, function (authenticated) {
                if (authenticated) {
                    var sql = "Select * from Groups inner join UserGroup on(UserGroup.groupID = Groups.groupID) where UserGroup.userID = ? and Groups.name like ?";
                    getAllSql(sql, [req.session.userId, "%" + fields.searchterm + "%"], function (groups) {
                        var render_args = {
                            errors: [],
                            groups: groups
                        };
                        res.send(eejs.require("ep_user_pad_frontend/templates/grouptables.ejs", render_args));
                    });

                } else {
                    res.send("You are not logged in!!");
                }
            });
        });
    });

    function inviteRegistered(email, inviter, location, userID, groupID, res) {
        var getGroupSql = "select * from Groups where Groups.groupID = ?";
        getAllSql(getGroupSql, [groupID], function (group) {
            var msg = eMailAuth.invitationmsg;
            msg = msg.replace(/<groupname>/, group[0].name);
            msg = msg.replace(/<fromuser>/, inviter);
            var loc = location.replace(/:\/$/, '/')
            msg = msg.replace(/<url>/, loc)
            var message = {
                text: msg,
                from: eMailAuth.invitationfrom,
                to: email + " <" + email + ">",
                subject: eMailAuth.invitationsubject
            };
            if (eMailAuth.smtp == "false") {
                var nodemailer = require('nodemailer');
                var transport = nodemailer.createTransport("sendmail");
                transport.sendMail(message);
            }
            else {
                emailserver.send(message, function (err) {
                    if (err) {
                        log('error', err);
                    }
                });
            }

            var existGroupSql = "select * from UserGroup where userID = ? and groupID = ?";
            getOneValueSql(existGroupSql, [userID, groupID], function (found) {
                if (found) {
                    sendError('One ore more user are already in Group', res);
                } else {
                    var sqlInsert = "INSERT INTO UserGroup Values(?,?,2)";
                    var insertQuery = connection.query(sqlInsert, [userID, groupID]);
                    insertQuery.on('error', mySqlErrorHandler);
                    insertQuery.on('end', function () {
                    });
                }
            });
        });
    }

    function inviteUnregistered(groupID, name, location, email, res) {
        var getGroupSql = "select * from Groups where Groups.groupID = ?";
        var queryInstances = connection.query(getGroupSql, [groupID]);
        queryInstances.on('error', mySqlErrorHandler);
        queryInstances.on('result', function (group) {
            var msg = eMailAuth.invitateunregisterednmsg;
            msg = msg.replace(/<groupname>/, group.name);
            msg = msg.replace(/<fromuser>/, name);
            var loc = location.replace(/:\/$/, '/')
            msg = msg.replace(/<url>/, loc)
            var message = {
                text: msg,
                from: eMailAuth.invitationfrom,
                to: email + " <" + email + ">",
                subject: eMailAuth.invitationsubject
            };
            if (eMailAuth.smtp == "false") {
                var nodemailer = require('nodemailer');
                var transport = nodemailer.createTransport("sendmail");
                transport.sendMail(message);
            }
            else {
                emailserver.send(message, function (err) {
                    if (err) {
                        log('error', err);
                    }
                });
            }
            var existGroupSql = "select * from NotRegisteredUsersGroups where email = ? and groupID = ?";
            getOneValueSql(existGroupSql, [email, groupID], function (found) {
                if (found) {
                    sendError('One ore more user are already Invited to this Group', res);
                } else {
                    var sqlInsert = "INSERT INTO NotRegisteredUsersGroups Values(?,?)";
                    var insertQuery = connection2.query(sqlInsert, [email, groupID]);
                    insertQuery.on('error', mySqlErrorHandler);
                    insertQuery.on('end', function () {
                    });
                }
            });
        });
    }

    function inviteUser(userN, location, groupID, res, currUserName) {
        var getUserSql = "select * from User where User.name = ?";
        getAllSql(getUserSql, [userN], function (user) {
            if (user[0] != null && user[0] != undefined && user.length > 0) {
                inviteRegistered(user[0].name, currUserName, location, user[0].userID, groupID, res);
            } else {
                inviteUnregistered(groupID, currUserName, location, userN, res);
            }
        });
    }

    args.app.post('/inviteUsers', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            userAuthenticated(req, function (authenticated) {
                if (authenticated) {
                    if (!fields.groupID) {
                        sendError('Group ID not defined', res);
                        return;
                    } else if (!fields.users[0]) {
                        sendError('No User given', res);
                        return;
                    }
                    var isOwnerSql = "SELECT * from UserGroup where UserGroup.userId = ? and UserGroup.groupID= ?";
                    getAllSql(isOwnerSql, [req.session.userId, fields.groupID], function (userGroup) {
                        if (!(userGroup[0].Role == 1)) {
                            sendError('User is not Owner can not send Invitations', res);
                        } else {
                            var data = {};
                            data.success = true;
                            getUser(req.session.userId, function (found, currUser) {
                                for (var i = 0; i < fields.users.length; i++) {
                                    if (fields.users[i] != "") {
                                        var userEmail = fields.users[i].toString().replace(/\s/g, '');
                                        inviteUser(userEmail, fields.location, fields.groupID, res, currUser[0].FullName);
                                    }
                                }
                                res.send(data);
                            });
                        }
                    });
                } else {
                    sendError("You are not logged in!", res);
                }
            });
        });
    });

    args.app.post('/userSearchTerm', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            userAuthenticated(req, function (authenticated) {
                if (authenticated) {
                    if (!fields.groupID) {
                        sendError('Group Id undefined', res);
                        return;
                    }
                    var isOwnerSql = "SELECT * from UserGroup where UserGroup.userId = ? and UserGroup.groupID= ?";
                    getAllSql(isOwnerSql, [req.session.userId, fields.groupID], function () {
                        var usersSql = "select User.name, User.FullName, User.userID, UserGroup.Role from User inner join UserGroup on(UserGroup.userID = User.userID) where User.userID not in (?) and User.userID in (select UserGroup.userID from UserGroup where groupID = ?) and UserGroup.groupID = ? and User.name like ?";
                        getAllSql(usersSql, [req.session.userId, fields.groupID, fields.groupID, "%" + fields.searchterm + "%"], function (users) {
                            var userNotRegisteredSql = "Select * from NotRegisteredUsersGroups where groupID = ?";
                            getAllSql(userNotRegisteredSql, [fields.groupID], function (notRegistereds) {
                                for (var i = 0; i < notRegistereds.length; i++) {
                                    var user = {};
                                    user.name = notRegistereds[i].email;
                                    user.notRegistered = true;
                                    users.push(user);
                                }
                                var data = {};
                                data.success = true;
                                data.users = users;
                                res.send(data);
                            });
                        });
                    });
                } else {
                    res.send("You are not logged in!!");
                }
            });
        });
    });

    args.app.post('/deleteNotRegUser', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            userAuthenticated(req, function (authenticated) {
                if (authenticated) {
                    var deleteNotRegisteredSql = "DELETE FROM NotRegisteredUsersGroups where groupID = ? and email = ?";
                    updateSql(deleteNotRegisteredSql, [fields.groupID, fields.username], function (success) {
                        var data = {};
                        data.success = success;
                        res.send(data);
                    });
                } else {
                    res.send("You are not logged in!!");
                }
            });
        });

    });

    args.app.post('/reinviteUser', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            userAuthenticated(req, function (authenticated) {
                if (authenticated) {
                    getGroup(fields.groupID, function (found, currGroup) {
                        getUser(req.session.userId, function (found, currUser) {
                            var msg = eMailAuth.invitateunregisterednmsg;
                            msg = msg.replace(/<groupname>/, currGroup[0].name);
                            msg = msg.replace(/<fromuser>/, currUser[0].name);
                            var loc = fields.location.replace(/:\/$/, '/')
                            msg = msg.replace(/<url>/, loc)
                            var message = {
                                text: msg,
                                from: eMailAuth.invitationfrom,
                                to: fields.username + " <" + fields.username + ">",
                                subject: eMailAuth.invitationsubject
                            };
                            if (eMailAuth.smtp == "false") {
                                var nodemailer = require('nodemailer');
                                var transport = nodemailer.createTransport("sendmail");
                                transport.sendMail(message);
                            }
                            else {
                                emailserver.send(message, function (err) {
                                    if (err) {
                                        log('error', err);
                                    }
                                });
                            }
                            var data = {};
                            data.success = true;
                            res.send(data);
                        });
                    });
                } else {
                    res.send("You are not logged in!!");
                }
            });
        });
    });

    args.app.post('/changeUserName', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            userAuthenticated(req, function (authenticated) {
                if (authenticated) {
                    if (fields.newUserName == "") {
                        sendError('User Name empty', res);
                        return;
                    }
                    var updateUserSql = "UPDATE User SET FullName = ? WHERE userID= ?";
                    var data = {};
                    updateSql(updateUserSql, [fields.newUserName, req.session.userId], function (success) {
                        data.success = success;
                        res.send(data);
                    });

                } else {
                    res.send("You are not logged in!!");
                }
            });
        });
    });

    args.app.post('/changeEmail', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            userAuthenticated(req, function (authenticated) {
                if (authenticated) {
                    if (fields.newEmail == "") {
                        sendError('Mail empty', res);
                        return;
                    }
                    var Ergebnis = fields.newEmail.toString().match(/[a-zA-Z0-9._-]+@[a-zA-Z0-9-]+.[a-zA-Z]{2,4}/);
                    if (!Ergebnis) {
                        sendError(NO_VALID_MAIL, res);
                        return;
                    }
                    var updateUserSql = "UPDATE User SET name = ? WHERE userID= ?";
                    var data = {};
                    updateSql(updateUserSql, [fields.newEmail, req.session.userId], function (success) {
                        data.success = success;
                        res.send(data);
                    });

                } else {
                    res.send("You are not logged in!!");
                }
            });
        });
    });

    args.app.post('/changeUserPw', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            userAuthenticated(req, function (authenticated) {
                if (authenticated) {
                    if (fields.newPW == "" || fields.oldPW == "") {
                        sendError('Password empty', res);
                        return;
                    }
                    getUser(req.session.userId, function (found, currUser) {
                        if (currUser) {
                            encryptPassword(fields.oldPW, currUser[0].salt, function (encrypted) {
                                if (currUser[0].pwd != encrypted) {
                                    sendError('Wrong Password', res);
                                    return;
                                }
                                createSalt(function (salt) {
                                    encryptPassword(fields.newPW, salt, function (newPass) {
                                        var updateUserSql = "UPDATE User SET pwd = ?, salt = ? WHERE userID= ?";
                                        var data = {};
                                        updateSql(updateUserSql, [newPass, salt, req.session.userId], function (success) {
                                            data.success = success;
                                            res.send(data);
                                        });
                                    });
                                });
                            });
                        }
                    });


                } else {
                    res.send("You are not logged in!!");
                }
            });
        });
    });

    args.app.post('/makeOwner', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            userAuthenticated(req, function (authenticated) {
                if (authenticated) {
                    if (!fields.userID || fields.userID == "" || !fields.groupID || fields.groupID == "") {
                        sendError('No User ID or Group ID given', res);
                        return false;
                    }
                    var isOwnerSql = "SELECT * from UserGroup where UserGroup.userId = ? and UserGroup.groupID= ?";
                    var retCode = getAllSql(isOwnerSql, [req.session.userId, fields.groupID], function (userGroup) {
                        if (!(userGroup[0].Role == 1)) {
                            sendError('User is not owner! Can not delete Pad', res);
                            return false;
                        } else {
                            var updateUserSql = "UPDATE UserGroup SET Role = 1 WHERE userID= ? and groupID = ?";
                            var data = {};
                            updateSql(updateUserSql, [fields.userID, fields.groupID], function (success) {
                                if (success) {
                                    var updateOldUserSql = "UPDATE UserGroup SET Role = 2 WHERE userID = ? and groupID = ?";
                                    updateSql(updateOldUserSql, [req.session.userId, fields.groupID], function (success) {
                                        if (!success) {
                                            log('error', 'SetRole = 2 failed after SetRole = 1 succeded');
                                        }
                                        data.success = success;
                                        res.send(data);
                                    });
                                    return true;
                                } else {
                                    return false;
                                }

                            });
                            return true;
                        }
                    });
                    return retCode;
                } else {
                    log('info', 'Not logged in Error: ' + req.path);
                    res.send("You are not logged in!!");
                    return false;
                }
            });
        });
    });


    args.app.post('/deleteUserFromGroup', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            userAuthenticated(req, function (authenticated) {
                if (authenticated) {
                    if (!fields.userID || fields.userID == "" || !fields.groupID || fields.groupID == "") {
                        sendError('No User ID or Group ID given', res);
                    } else {
                        var isOwnerSql = "SELECT * from UserGroup where UserGroup.userId = ? and UserGroup.groupID= ?";
                        getAllSql(isOwnerSql, [req.session.userId, fields.groupID], function (userGroup) {
                            if (!(userGroup[0].Role == 1)) {
                                sendError('You are not the owner of this group!!', res);
                                return false;
                            } else {
                                var deleteUserFromGroupSql = "Delete from UserGroup where userID = ? and groupID = ?";
                                var data = {};
                                updateSql(deleteUserFromGroupSql, [fields.userID, fields.groupID], function (success) {
                                    data.success = success;
                                    res.send(data);
                                });
                                return true;
                            }
                        });
                    }
                } else {
                    res.send("You are not logged in!!");
                }
            });
        });
    });

    args.app.post('/deleteUser', function (req, res) {
        userAuthenticated(req, function (authenticated) {
            if (authenticated) {
                var isOwnerAnywhere = "select * from UserGroup where userID = ? and UserGroup.Role = 1";
                getOneValueSql(isOwnerAnywhere, [req.session.userId], function (found, UserGroup) {
                    if (found) {
                        sendError('You are owner in one ore more groups. Please select a follower for the ownership', res);
                        return false;
                    } else {
                        var deleteSql = "Delete from UserGroup where userID = ?";
                        var data = {};
                        updateSql(deleteSql, [req.session.userId], function (success) {
                            if (!success) {
                                res.send(data);
                                return;
                            }
                            var deleteSqlUser = "Delete from User where userID = ?";
                            updateSql(deleteSqlUser, [req.session.userId], function (success2) {
                                if (!success2) {
                                    res.end(data);
                                    return;
                                }
                                req.session.email = null;
                                req.session.password = null;
                                req.session.userId = null;
                                req.session.username = null;
                                data.success = success;
                                res.send(data);
                            });
                        });
                        return true;
                    }
                });
            } else {
                res.send("You are not logged in!!");
            }
        });
    });


    args.app.post('/directToPad', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            userAuthenticated(req, function (authenticated) {
                if (authenticated) {
                    if (!fields.groupId) {
                        sendError('Group-Id not defined', res);
                        return;
                    }
                    var userInGroupSql = "SELECT * from UserGroup where UserGroup.userId = ? and UserGroup.groupID= ?";
                    getOneValueSql(userInGroupSql, [req.session.userId, fields.groupId], function (found) {
                        if (found) {
                            getEtherpadGroupFromNormalGroup(fields.groupId, function (group) {
                                addUserToEtherpad(req.session.userId, function (etherpad_author) {
                                    sessionManager.createSession(group, etherpad_author.authorID, Date.now() +
                                        7200000, function (err, session) {
                                        var data = {};
                                        data.success = true;
                                        data.session = session.sessionID;
                                        data.group = group;
                                        data.pad_name = fields.padname;
                                        data.location = fields.location;
                                        res.send(data);
                                    });
                                });
                            });
                        } else {
                            sendError('User not in Group', res);
                        }
                    });

                } else {
                    res.send("You are not logged in!!");

                }
            });
        });
    });

    args.app.get('/group.html/:groupID/pad.html/:padID', function (req, res) {
        userAuthenticated(req, function (authenticated) {
            getGroup(req.params.groupID, function (found, currGroup) {
                getUser(req.session.userId, function (found, currUser) {
                    var padID = req.params.padID;
                    var slice = padID.indexOf("$");
                    padID = padID.slice(slice + 1, padID.length);
                    var padsql = "select * from GroupPads where PadName = ?";
                    existValueInDatabase(padsql, [padID], function (found) {
                        var render_args;
                        if (!found) {
                            render_args = {
                                errors: [],
                                msg: "This pad does not exist! Perhabs anyone has deleted the pad."
                            };
                            res.send(eejs
                                .require("ep_user_pad_frontend/templates/msgtemplate.ejs",
                                    render_args));
                        } else {
                            if (currGroup && currGroup.length > 0) {
                                if (authenticated) {
                                    if (currUser) {
                                        render_args = {
                                            errors: [],
                                            padname: padID,
                                            username: currUser[0].FullName,
                                            groupID: req.params.groupID,
                                            groupName: currGroup[0].name,
                                            padurl: req.session.baseurl + "p/" + req.params.padID
                                        };
                                        res.send(eejs
                                            .require("ep_user_pad_frontend/templates/pad.ejs",
                                                render_args));
                                    } else
                                        res.send("Error");
                                } else {
                                    render_args = {
                                        errors: [],
                                        padname: req.params.padID,
                                        username: req.session.username,
                                        groupID: req.params.groupID,
                                        groupName: currGroup[0].name,
                                        padurl: req.session.baseurl + "p/" + req.params.padID
                                    };
                                    res.send(eejs
                                        .require("ep_user_pad_frontend/templates/pad_with_login.ejs",
                                            render_args));
                                }
                            } else {
                                render_args = {
                                    errors: [],
                                    msg: "This group does not exist! Perhabs anyone has deleted the group."
                                };
                                res.send(eejs
                                    .require("ep_user_pad_frontend/templates/msgtemplate.ejs",
                                        render_args));
                            }
                        }
                    });
                });
            });
        });
    });

    args.app.get('/imprint.html', function (req, res) {
        var render_args = {
            errors: []
        };
        res.send(eejs.require("ep_user_pad_frontend/templates/imprint.html", render_args));
    });

    args.app.get('/public_pad/:id', function (req, res) {
        userAuthenticated(req, function (authenticated) {
            var render_args;
            if (authenticated) {
                render_args = {
                    errors: [],
                    padurl: "p/" + req.params.id,
                    username: req.session.username,
                    padName: req.params.id
                };
                res.send(eejs
                    .require("ep_user_pad_frontend/templates/public_pad_logged_in.ejs",
                        render_args));
            } else {
                render_args = {
                    errors: [],
                    padurl: "./../p/" + req.params.id
                };
                res.send(eejs
                    .require("ep_user_pad_frontend/templates/public_pad.ejs",
                        render_args));
            }
        });
    });

    args.app.post('/login', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            if (!fields.email) {
                sendError('No valid E-mail Address given', res);
                return false;
            } else if (!fields.password) {
                sendError('No password given', res);
                return false;
            }

            var email = fields.email;
            var password = fields.password;

            var retVal = userAuthentication(email, password, function (success, user, userFound, considered, active) {
                if (success) {
                    req.session.email = email;
                    req.session.password = password;
                    req.session.userId = user.userID;
                    req.session.username = user.FullName;
                    req.session.baseurl = fields.url;
                    var data = {};
                    data.success = true;
                    res.send(data);
                    return true;
                } else {
                    if (!active) {
                        sendError('User is inactive', res);
                    }
                    else if (!userFound || considered) {
                        sendError('User or password wrong!', res);
                    }
                    else if (userFound && !considered) {
                        sendError('You have to confirm your registration!', res);
                    }
                    return false;
                }
            });
            return retVal;
        });
    });

    args.app.post('/register', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            var user = {};
            user.fullname = fields.fullname;
            user.email = fields.email;
            user.password = fields.password;
            user.passwordrepeat = fields.passwordrepeat;
            user.location = fields.location;
            registerUser(user, function (success, error) {
                if (!success) {
                    sendError(error, res);
                } else {
                    var data = {};
                    data.success = success;
                    data.error = error;
                    res.send(data);
                }
            });
        });
    });

    args.app.post('/logout', function (req, res) {
        req.session.email = null;
        req.session.password = null;
        req.session.userId = null;
        req.session.username = null;
        res.send(true);
    });

    args.app.get('/confirm/:consString', function (req, res) {
        var sql = "Select * from User where User.considerationString = ?";
        getOneValueSql(sql, [req.params.consString], function (found, user) {
            var render_args;
            if (!found) {
                render_args = {
                    errors: [],
                    msg: "User not found!"
                };
                res.send(eejs
                    .require("ep_user_pad_frontend/templates/msgtemplate.ejs",
                        render_args));
            } else {
                if (user[0].considered) {
                    render_args = {
                        errors: [],
                        msg: 'User already confirmed!'
                    };
                    res.send(eejs
                        .require("ep_user_pad_frontend/templates/msgtemplate.ejs",
                            render_args));
                } else {
                    var sql2 = "Update User SET considered = 1 WHERE User.userID = ?";
                    updateSql(sql2, [user[0].userID], function (success) {
                        if (success) {
                            var render_args = {
                                errors: [],
                                msg: 'Thanks for your registration!'
                            };
                            res.send(eejs
                                .require("ep_user_pad_frontend/templates/msgtemplate.ejs",
                                    render_args));
                        } else {
                            res.send('Something went wrong');
                        }
                    });
                }
            }
        });
    });

    args.app.post('/getUser', function (req, res) {
        userAuthenticated(req, function (authenticated) {
            if (authenticated) {
                getUser(req.session.userId, function (found, currUser) {
                    var data = {};
                    data.success = true;
                    data.user = currUser;
                    res.send(data);
                });
            } else {
                res.send("You are not logged in!!");
            }
        });
    });


    args.app.post('/createGroup', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            userAuthenticated(req, function (authenticated) {
                var data = {};
                if (authenticated) {
                    if (!fields.groupName) {
                        sendError("Group Name not defined", res);
                        return;
                    }
                    var existGroupSql = "SELECT * from Groups WHERE Groups.name = ?";
                    getOneValueSql(existGroupSql, [fields.groupName], function (found) {
                        if (found) {
                            sendError('Group already exists', res);
                            return;
                        } else {
                            var addGroupSql = "INSERT INTO Groups VALUES(null, ?)";
                            var addGroupQuery = connection.query(addGroupSql, [fields.groupName]);
                            addGroupQuery.on('error', mySqlErrorHandler);
                            addGroupQuery.on('result', function (group) {
                                data.groupid = group.insertId;
                                connection.pause();
                                var addUserGroupSql = "INSERT INTO UserGroup Values(?,?,1)";
                                var addUserGroupQuery = connection2.query(addUserGroupSql, [req.session.userId, group.insertId]);
                                addUserGroupQuery.on('error', mySqlErrorHandler);
                                addUserGroupQuery.on('result', function () {
                                    groupManager.createGroupIfNotExistsFor(group.insertId.toString(), function (err, val) {
                                        if (err) {
                                            log('error', 'failed to createGroupIfNotExistsFor');
                                        }
                                    });
                                });
                                addUserGroupQuery.on('end', function() {
                                    connection.resume();
                                })
                            });
                        }
                        addGroupQuery.on('end', function () {
                            data.success = true;
                            data.error = null;
                            res.send(data);
                        });
                    });
                } else {
                    res.send("You are not logged in!!");
                }
            });
        });
    });

    args.app.post('/createPad', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            if (err) {
                log('error', 'formidable parsing error in ' + req.path);
                res.send(err);
                return;
            }
            userAuthenticated(req, function (authenticated) {
                if (authenticated) {
                    if (!fields.groupId) {
                        sendError('Group-Id not defined', res);
                        return;
                    } else if (!fields.padName) {
                        sendError('Pad Name not defined', res);
                        return;
                    }
                    var existPadInGroupSql = "SELECT * from GroupPads where GroupPads.GroupID = ? and GroupPads.PadName = ?";
                    getOneValueSql(existPadInGroupSql, [fields.groupId, fields.padName], function (found) {
                        if (found || (fields.padName.length == 0)) {
                            sendError('Pad already Exists', res);
                        } else {
                            var addPadToGroupSql = "INSERT INTO GroupPads VALUES(?, ?)";
                            var addPadToGroupQuery = connection.query(addPadToGroupSql, [fields.groupId, fields.padName]);
                            addPadToGroupQuery.on('error', mySqlErrorHandler);
                            addPadToGroupQuery.on('end', function () {
                                addPadToEtherpad(fields.padName, fields.groupId, function () {
                                    var data = {};
                                    data.success = true;
                                    data.error = null;
                                    res.send(data);
                                });
                            });
                        }
                    });
                } else {
                    res.send("You are not logged in!!");
                }
            });
        });
    });

    args.app.post('/deletePad', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            userAuthenticated(req, function (authenticated) {
                var data = {};
                if (authenticated) {
                    if (!fields.groupId) {
                        sendError('Group-Id not defined', res);
                        return;
                    } else if (!fields.padName) {
                        sendError('Pad Name not defined', res);
                        return;
                    }
                    var isOwnerSql = "SELECT * from UserGroup where UserGroup.userId = ? and UserGroup.groupID= ?";
                    getAllSql(isOwnerSql, [req.session.userId, fields.groupId], function (userGroup) {
                        if (!(userGroup[0].Role == 1)) {
                            sendError('User is not owner! Can not delete Pad', res);
                        } else {
                            getEtherpadGroupFromNormalGroup(fields.groupId, function () {
                                var deletePadSql = "DELETE FROM GroupPads WHERE GroupPads.PadName = ? and GroupPads.GroupID = ?";
                                var deletePadQuery = connection.query(deletePadSql, [fields.padName, fields.groupId]);
                                deletePadQuery.on('error', mySqlErrorHandler);
                                deletePadQuery.on('result', function (pad) {
                                });
                                deletePadQuery.on('end', function () {
                                    deletePadFromEtherpad(fields.padName, fields.groupId, function () {
                                        data.success = true;
                                        data.error = null;
                                        res.send(data);
                                    });

                                });
                            });
                        }
                    });
                } else {
                    res.send("You are not logged in!!");
                }
            });
        });
    });

    args.app.post('/deleteGroup', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            userAuthenticated(req, function (authenticated) {
                var data = {};
                if (authenticated) {
                    if (!fields.groupId) {
                        sendError('Group-Id not defined', res);
                        return;
                    }
                    var isOwnerSql = "SELECT * from UserGroup where UserGroup.userId = ? and UserGroup.groupID= ?";
                    getAllSql(isOwnerSql, [req.session.userId, fields.groupId], function (userGroup) {
                        if (!userGroup) {
                            sendError('You are not in this Group.', res);
                        }
                        if (!(userGroup[0].Role == 1)) {
                            sendError('User is not Owner. Can not delete Group', res);
                        } else {
                            var deleteGroupSql = "DELETE FROM Groups WHERE Groups.groupID = ?";
                            var deleteGroupQuery = connection.query(deleteGroupSql, [fields.groupId]);
                            deleteGroupQuery.on('error', mySqlErrorHandler);
                            deleteGroupQuery.on('result', function () {
                                connection.pause();
                                var deleteUserGroupSql = "DELETE FROM UserGroup where UserGroup.groupID = ?";
                                var deleteUserGroupQuery = connection2.query(deleteUserGroupSql, [fields.groupId]);
                                deleteUserGroupQuery.on('error', mySqlErrorHandler);
                                deleteUserGroupQuery.on('end', function () {
                                    var deleteGroupPadsSql = "DELETE FROM GroupPads where GroupPads.groupID = ?";
                                    var deleteGroupPadsQuery = connection2.query(deleteGroupPadsSql, [fields.groupId]);
                                    deleteGroupPadsQuery.on('error', mySqlErrorHandler);
                                    deleteGroupPadsQuery.on('end', function () {
                                        var deleteGroupNotInvited = "DELETE FROM NotRegisteredUsersGroups where NotRegisteredUsersGroups.groupID = ?";
                                        var deleteGroupNotInvitedQuery = connection2.query(deleteGroupNotInvited, [fields.groupId]);
                                        deleteGroupNotInvitedQuery.on('error', mySqlErrorHandler);
                                        deleteGroupNotInvitedQuery.on('end', function () {
                                            deleteGroupFromEtherpad(fields.groupId, function () {
                                                connection.resume();
                                            });
                                        });
                                    });
                                });
                            });
                            deleteGroupQuery.on('end', function () {
                                data.success = true;
                                data.error = null;
                                res.send(data);
                            });
                        }

                    });
                } else {
                    res.send("You are not logged in!!");
                }
            });
        });
    });


    args.app.post('/setPassword', function (req, res) {
        new formidable.IncomingForm().parse(req, function (err, fields) {
            userAuthenticated(req, function (authenticated) {
                var data = {};
                if (authenticated) {
                    if (!fields.groupId) {
                        sendError('Group-Id not defined', res);
                        return;
                    }
                    var isOwnerSql = "SELECT * from UserGroup where UserGroup.userId = ? and UserGroup.groupID= ?";
                    getAllSql(isOwnerSql, [req.session.userId, fields.groupId], function (userGroup) {
                        if (!(userGroup[0].Role == 1) || fields.pw == '') {
                            sendError('User is not owner! Can not set Password', res);
                            return false;
                        } else {
                            getEtherpadGroupFromNormalGroup(fields.groupId, function (group) {
                                padManager.getPad(group + "$" + fields.padName, null, function (err, origPad) {
                                    if (err) {
                                        log('error', err);
                                        return false;
                                    }
                                    origPad.setPassword(fields.pw);
                                    data.success = true;
                                    data.error = null;
                                    res.send(data);
                                    return true;
                                });
                            });
                            return true;
                        }
                    });
                } else {
                    res.send("You are not logged in!!");
                }
            });
        });
    });
    return cb();

};
exports.eejsBlock_indexWrapper = function (hook_name, args, cb) {
    args.content = eejs
        .require("ep_user_pad_frontend/templates/index_redirect.ejs");
    return cb();
};

exports.eejsBlock_styles = function (hook_name, args, cb) {
    return cb();
};



