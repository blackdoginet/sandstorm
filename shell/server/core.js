// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const Capnp = Npm.require("capnp");
const Url = Npm.require("url");
import { PersistentImpl, hashSturdyRef, generateSturdyRef } from "/imports/server/persistent.js";

const PersistentHandle = Capnp.importSystem("sandstorm/supervisor.capnp").PersistentHandle;
const SandstormCore = Capnp.importSystem("sandstorm/supervisor.capnp").SandstormCore;
const SandstormCoreFactory = Capnp.importSystem("sandstorm/backend.capnp").SandstormCoreFactory;
const PersistentOngoingNotification = Capnp.importSystem("sandstorm/supervisor.capnp").PersistentOngoingNotification;
const PersistentUiView = Capnp.importSystem("sandstorm/persistentuiview.capnp").PersistentUiView;
const StaticAsset = Capnp.importSystem("sandstorm/grain.capnp").StaticAsset;
const SystemPersistent = Capnp.importSystem("sandstorm/supervisor.capnp").SystemPersistent;

class SandstormCoreImpl {
  constructor(grainId) {
    this.grainId = grainId;
  }

  restore(sturdyRef) {
    return inMeteor(() => {
      const hashedSturdyRef = hashSturdyRef(sturdyRef);
      const token = ApiTokens.findOne({
        _id: hashedSturdyRef,
        "owner.grain.grainId": this.grainId,
      });

      if (!token) {
        throw new Error("no such token");
      }

      if (token.owner.grain.introducerIdentity) {
        throw new Error("Cannot restore grain-owned sturdyref that contains the obsolete " +
                        "introducerIdentity field. Please request a new capability.");
      }

      return restoreInternal(sturdyRef,
                             { grain: Match.ObjectIncluding({ grainId: this.grainId }) },
                             [], token);
    });
  }

  drop(sturdyRef) {
    return inMeteor(() => {
      return dropInternal(sturdyRef, { grain: Match.ObjectIncluding({ grainId: this.grainId }) });
    });
  }

  makeToken(ref, owner, requirements) {
    const _this = this;
    return inMeteor(() => {
      const sturdyRef = new Buffer(generateSturdyRef());
      const hashedSturdyRef = hashSturdyRef(sturdyRef);
      ApiTokens.insert({
        _id: hashedSturdyRef,
        grainId: _this.grainId,
        objectId: ref,
        owner: owner,
        created: new Date(),
        requirements: requirements,
      });

      return {
        token: sturdyRef,
      };
    });
  }

  makeChildToken(parent, owner, requirements) {
    return inMeteor(() => {
      // Compute the save ApiToken template.
      return makeSaveTemplateForChild(parent.toString(), requirements);
    }).then(saveTemplate => {
      // Create a dummy PersistentImpl and invoke its own save() method.
      return new PersistentImpl(globalDb, saveTemplate).save({ sealFor: owner });
    }).then(saveResult => {
      // Transform to expected result structure.
      return { token: saveResult.sturdyRef };
    });
  }

  getOwnerNotificationTarget() {
    const grainId = this.grainId;
    return {
      owner: {
        addOngoing: (displayInfo, notification) => {
          return inMeteor(() => {
            const grain = Grains.findOne({ _id: grainId });
            if (!grain) {
              throw new Error("Grain not found.");
            }

            const castedNotification = notification.castAs(PersistentOngoingNotification);
            const wakelockToken = waitPromise(castedNotification.save()).sturdyRef;

            // We have to close both the casted cap and the original. Perhaps this should be fixed in
            // node-capnp?
            castedNotification.close();
            notification.close();
            const notificationId = Notifications.insert({
              ongoing: wakelockToken,
              grainId: grainId,
              userId: grain.userId,
              text: displayInfo.caption,
              timestamp: new Date(),
              isUnread: true,
            });

            return {
              handle: globalFrontendRefRegistry.restore(globalDb,
                  { notificationHandle: notificationId }),
            };
          });
        },
      },
    };
  }

  backgroundActivity(event) {
    return inMeteor(() => {
      logActivity(this.grainId, null, event);
    });
  }
}

const makeSandstormCore = (grainId) => {
  return new Capnp.Capability(new SandstormCoreImpl(grainId), SandstormCore);
};

class NotificationHandle extends PersistentImpl {
  // TODO(cleanup): Move to a different file.

  constructor(db, saveTemplate, notificationId) {
    super(db, saveTemplate);
    this.notificationId = notificationId;
    this.saved = !!saveTemplate.parentToken;  // TODO(cleanup): ugly
  }

  close() {
    const _this = this;
    return inMeteor(() => {
      if (!_this.saved) {
        dismissNotification(_this.notificationId);
      }
    });
  }
}

const PROTOCOL = Url.parse(process.env.ROOT_URL).protocol;

class StaticAssetImpl {
  constructor(assetId) {
    check(assetId, String);
    this._protocol = PROTOCOL.slice(0, -1);
    this._hostPath = makeWildcardHost("static") + "/" + assetId;
  }

  getUrl() {
    return { protocol: this._protocol, hostPath: this._hostPath, };
  }
}

class IdenticonStaticAssetImpl {
  constructor(hash, size) {
    check(hash, String);
    check(size, Match.Integer);
    this._protocol = PROTOCOL.slice(0, -1);
    this._hostPath =  makeWildcardHost("static") + "/identicon/" + hash + "?s=" + size;
  }

  getUrl() {
    return { protocol: this._protocol, hostPath: this._hostPath, };
  }
}

class PersistentUiViewImpl extends PersistentImpl {
  // TODO(cleanup): Move out of core.js.

  constructor(db, saveTemplate, grainId) {
    super(db, saveTemplate);
    check(grainId, String);
    this._db = db;
    this._grainId = grainId;
  }

  getViewInfo() {
    return inMeteor(() => {
      const grain = this._db.getGrain(this._grainId);
      if (!grain || grain.trashed) {
        throw new Error("grain no longer exists");
      }

      let pkg = this._db.getPackage(grain.packageId) ||
        DevPackages.findOne({ appId: grain.appId }) ||
        {};

      const manifest = pkg.manifest || {};

      const viewInfo = grain.cachedViewInfo || {};

      if (!viewInfo.appTitle) {
        viewInfo.appTitle = manifest.appTitle || {};
      }

      if (!viewInfo.grainIcon) {
        const grainIcon = ((manifest.metadata || {}).icons || {}).grain;
        if (grainIcon) {
          viewInfo.grainIcon = new Capnp.Capability(new StaticAssetImpl(grainIcon.assetId),
                                                    StaticAsset);
        } else {
          const hash = Identicon.hashAppIdForIdenticon(pkg.appId);
          viewInfo.grainIcon = new Capnp.Capability(new IdenticonStaticAssetImpl(hash, 24),
                                                    StaticAsset);
        }
      }

      return viewInfo;
    });
  }

  // All other UiView methods are currently unimplemented, which, while not strictly correct,
  // results in the same overall behavior, since users can't call restore() on a PersistentUiView,
  // and grains can't call methods on UiViews because they lack the "is human" pseudopermission.
}

const makePersistentUiView = function (db, saveTemplate, grainId) {
  check(grainId, String);

  // Verify that the grain exists and hasn't been trashed.
  const grain = db.getGrain(grainId);
  if (!grain || grain.trashed) {
    throw new Meteor.Error(404, "grain not found");
  }

  return new Capnp.Capability(new PersistentUiViewImpl(db, saveTemplate, grainId),
                              PersistentUiView);
};

globalFrontendRefRegistry.addRestoreHandler("notificationHandle",
    (db, saveTemplate, notificationId) => {
  return new Capnp.Capability(new NotificationHandle(db, saveTemplate, notificationId),
                              PersistentHandle);
});

function dismissNotification(notificationId, callCancel) {
  const notification = Notifications.findOne({ _id: notificationId });
  if (notification) {
    Notifications.remove({ _id: notificationId });
    if (notification.ongoing) {
      // For some reason, Mongo returns an object that looks buffer-like, but isn't a buffer.
      // Only way to fix seems to be to copy it.
      const id = new Buffer(notification.ongoing);

      if (!callCancel) {
        dropInternal(id, { frontend: null });
      } else {
        const notificationCap = restoreInternal(id, { frontend: null }, []).cap;
        const castedNotification = notificationCap.castAs(PersistentOngoingNotification);
        dropInternal(id, { frontend: null });
        try {
          waitPromise(castedNotification.cancel());
          castedNotification.close();
          notificationCap.close();
        } catch (err) {
          if (err.kjType !== "disconnected") {
            // ignore disconnected errors, since cancel may shutdown the grain before the supervisor
            // responds.
            throw err;
          }
        }
      }
    } else if (notification.appUpdates) {
      _.forEach(notification.appUpdates, (app, appId) => {
        globalDb.deleteUnusedPackages(appId);
      });
    }
  }
}

Meteor.methods({
  dismissNotification(notificationId) {
    // This will remove notifications from the database and from view of the user.
    // For ongoing notifications, it will begin the process of cancelling and dropping them from
    // the app.

    check(notificationId, String);

    const notification = Notifications.findOne({ _id: notificationId });
    if (!notification) {
      throw new Meteor.Error(404, "Notification id not found.");
    } else if (notification.userId !== Meteor.userId()) {
      throw new Meteor.Error(403, "Notification does not belong to current user.");
    } else {
      dismissNotification(notificationId, true);
    }
  },

  readAllNotifications() {
    // Marks all notifications as read for the current user.
    if (!Meteor.userId()) {
      throw new Meteor.Error(403, "User not logged in.");
    }

    Notifications.update({ userId: Meteor.userId() }, { $set: { isUnread: false } }, { multi: true });
  },
});

// TODO(now): Get rid of this maybe?
saveFrontendRef = (frontendRef, owner, requirements) => {
  return inMeteor(() => {
    const sturdyRef = new Buffer(generateSturdyRef());
    const hashedSturdyRef = hashSturdyRef(sturdyRef);
    ApiTokens.insert({
      _id: hashedSturdyRef,
      frontendRef: frontendRef,
      owner: owner,
      created: new Date(),
      requirements: requirements,
    });
    return { sturdyRef: sturdyRef };
  });
};

checkRequirements = (requirements) => {
  if (!requirements) {
    return true;
  }

  for (let i in requirements) {
    const requirement = requirements[i];
    if (requirement.tokenValid) {
      const token = ApiTokens.findOne({ _id: requirement.tokenValid, revoked: { $ne: true }, },
                                      { fields: { requirements: 1 } });
      if (!token || !checkRequirements(token.requirements)) {
        return false;
      }

      if (token.parentToken && !checkRequirements([{ tokenValid: token.parentToken }])) {
        return false;
      }
    } else if (requirement.permissionsHeld) {
      const p = requirement.permissionsHeld;
      const viewInfo = Grains.findOne(p.grainId, { fields: { cachedViewInfo: 1 } }).cachedViewInfo;
      const currentPermissions = SandstormPermissions.grainPermissions(
        globalDb,
        { grain: { _id: p.grainId, identityId: p.identityId } }, viewInfo || {}).permissions;
      if (!currentPermissions) {
        return false;
      }

      const requiredPermissions = p.permissions || [];
      for (let ii = 0; ii < requiredPermissions.length; ++ii) {
        if (requiredPermissions[ii] && !currentPermissions[ii]) {
          return false;
        }
      }
    } else if (requirement.userIsAdmin) {
      if (!isAdminById(requirement.userIsAdmin)) {
        return false;
      }
    } else {
      throw new Meteor.Error(403, "Unknown requirement");
    }
  }

  return true;
};

const makeSaveTemplateForChild = function (parentToken, requirements, parentTokenInfo) {
  // Constructs (part of) an ApiToken record appropriate to be used when save()ing a capability
  // that was originally created by restore()ing `parentToken`. This fills in everything that is
  // appropriate to fill in based only on the parent. Some fields -- especially `owner`, `created`,
  // and `_id` -- obviously cannot be filled in until `save()` is called.
  //
  // `parentToken` is the raw SturdyRef of the parent.
  //
  // `requirements` is a list of MembraneRequirements that should be added to any children.
  //
  // `parentTokenInfo` is the ApiToken record for `parentToken`. Provide this only if you have
  // it handy; if omitted it will be looked up.

  parentTokenInfo = parentTokenInfo || ApiTokens.findOne(hashSturdyRef(parentToken));
  if (!parentTokenInfo) {
    throw new Error("no such token");
  }

  let saveTemplate;
  if ((parentTokenInfo.owner || {}).clientPowerboxRequest) {
    // Saving this token should make a copy of the restored token, rather than make a child
    // token.

    saveTemplate = _.clone(parentTokenInfo);

    // Don't copy over fields that should be determined at save() time.
    delete saveTemplate._id;
    delete saveTemplate.owner;
    delete saveTemplate.created;
  } else {
    if (parentTokenInfo.identityId) {
      // A UiView token. Need to denormalize some fields from the parent.
      saveTemplate = _.pick(parentTokenInfo, "grainId", "identityId", "accountId");

      // By default, a save()d copy should have the same permissions, so set an allAccess role
      // assignment.
      saveTemplate.roleAssignment = { allAccess: null };
    } else {
      // A non-UiView child token.
      saveTemplate = {};
    }

    // Saved token should be a child of the restored token.
    saveTemplate.parentToken = parentTokenInfo._id;
  }

  if (requirements) {
    // Append additional requirements requested by caller.
    saveTemplate.requirements = (saveTemplate.requirements || []).concat(requirements);
  }

  return saveTemplate;
};

restoreInternal = (originalToken, ownerPattern, requirements, originalTokenInfo,
                   currentTokenId) => {
  // Restores the token `originalToken`, which is a Buffer.
  //
  // `ownerPattern` is a match pattern (i.e. used with check()) that the token's owner must match.
  // This is used to enforce than an entity can't use tokens owned by some other entity.
  //
  // `requirements` is a list of additional MembraneRequirements to add to the returned capability,
  // beyond what's already stored in ApiTokens. This is often an empty list.
  //
  // `originalTokenInfo` is optional. If specified, it should be the ApiToken record associated
  // with `originalToken`. Provide this if you happen to have looked it up already.
  //
  // `currentTokenId` is only provided when this function calls itself recursively. It is the
  // _id (hashed token) of an ancestor of originalToken. The function recurses until it gets to
  // the top-level token.

  requirements = requirements || [];

  if (!originalTokenInfo) {
    originalTokenInfo = ApiTokens.findOne(hashSturdyRef(originalToken));
    if (!originalTokenInfo) {
      throw new Meteor.Error(403, "No token found to restore");
    }
  }

  const token = currentTokenId ?
      ApiTokens.findOne(currentTokenId) : originalTokenInfo;
  if (!token) {
    if (!originalTokenInfo) {
      throw new Meteor.Error(403, "Couldn't restore token because parent token has been deleted");
    }
  }

  if (token.revoked) {
    throw new Meteor.Error(403, "Token has been revoked");
  }

  // The ownerPattern should specify the appropriate user or grain involved, if appropriate.
  check(token.owner, ownerPattern);

  // Check requirements on the token.
  if (!checkRequirements(token.requirements)) {
    throw new Meteor.Error(403, "Requirements not satisfied.");
  }

  // Check expiration.
  if (token.expires && token.expires.getTime() <= Date.now()) {
    throw new Meteor.Error(403, "Authorization token expired");
  }

  if (token.expiresIfUnused) {
    if (token.expiresIfUnused.getTime() <= Date.now()) {
      throw new Meteor.Error(403, "Authorization token expired");
    } else {
      // It's getting used now, so clear the expiresIfUnused field.
      ApiTokens.update(token._id, { $unset: { expiresIfUnused: "" } });
    }
  }

  // If this token has a parent, go ahead and recurse to it now.
  if (token.parentToken) {
    // A token which chains to some parent token.  Restore the parent token (possibly recursively),
    // checking requirements on the way up.
    return restoreInternal(originalToken, Match.Any, requirements,
                           originalTokenInfo, token.parentToken);
  }

  // Check the passed-in `requirements`.
  if (!checkRequirements(requirements)) {
    throw new Meteor.Error(403, "Requirements not satisfied.");
  }

  if (token.objectId) {
    // A token which represents a specific capability exported by a grain.

    // Fix Mongo converting Buffers to Uint8Arrays.
    if (token.objectId.appRef) {
      token.objectId.appRef = new Buffer(token.objectId.appRef);
    }

    // Ensure the grain is running, then restore the capability.
    return waitPromise(globalBackend.useGrain(token.grainId, (supervisor) => {
      // Note that in this case it is the supervisor's job to implement SystemPersistent, so we
      // discard persistentMethods.
      return supervisor.restore(token.objectId, requirements, originalToken);
    }));
  } else {
    // Construct a template ApiToken for use if the restored capability is save()d later.
    const saveTemplate = makeSaveTemplateForChild(originalToken, requirements, originalTokenInfo);

    if (token.frontendRef) {
      // A token which represents a capability implemented by a pseudo-driver.

      const cap = globalFrontendRefRegistry.restore(globalDb, saveTemplate, token.frontendRef);
      return { cap };
    } else if (token.grainId) {
      // It's a UiView.

      // If a grain is attempting to restore a UiView, it gets a UiView which filters out all
      // the method calls.  In the future, we may allow grains to restore UiViews that pass along the
      // "is human" pseudopermission (say, to allow an app to proxy all requests to some grain and
      // do some transformation), which will return a different capability.
      return { cap: makePersistentUiView(globalDb, saveTemplate, token.grainId) };
    } else {
      console.log(token);
      throw new Meteor.Error(500, "Unknown token type. ID: " + token._id);
    }
  }
};

function dropInternal(sturdyRef, ownerPattern) {
  // Drops `sturdyRef`, checking first that its owner matches `ownerPattern`.

  const hashedSturdyRef = hashSturdyRef(sturdyRef);
  const token = ApiTokens.findOne({ _id: hashedSturdyRef });
  if (!token) {
    return;
  }

  check(token.owner, ownerPattern);

  if (token.frontendRef && token.frontendRef.notificationHandle) {
    const notificationId = token.frontendRef.notificationHandle;
    globalDb.removeApiTokens({ _id: hashedSturdyRef });
    const anyToken = ApiTokens.findOne({ "frontendRef.notificationHandle": notificationId });
    if (!anyToken) {
      // No other tokens referencing this notification exist, so dismiss the notification
      dismissNotification(notificationId);
    }
  } else if (token.objectId) {
    waitPromise(globalBackend.useGrain(token.grainId, (supervisor) => {
      return supervisor.drop(token.objectId);
    }));

    globalDb.removeApiTokens({ _id: hashedSturdyRef });
  } else {
    globalDb.removeApiTokens({ _id: hashedSturdyRef });
  }
}

function SandstormCoreFactoryImpl() {
}

SandstormCoreFactoryImpl.prototype.getSandstormCore = (grainId) => {
  return { core: makeSandstormCore(grainId) };
};

makeSandstormCoreFactory = () => {
  return new Capnp.Capability(new SandstormCoreFactoryImpl(), SandstormCoreFactory);
};

unwrapFrontendCap = (cap, type, callback) => {
  // Expect that `cap` is a Cap'n Proto capability implemented by the frontend as a frontendRef
  // with the given type (the name of one of the fields of frontendRef). Unwraps the capability
  // and then calls callback() with the `frontendRef[type]` descriptor object as
  // the paramater. The callback runs in a Meteor fiber, but this function can be called from
  // anywhere. The function returns a Promise for the result of the callback.
  //
  // (The reason for the callback, rather than just returning a Promise for the descriptor, is
  // so that you don't have to do your own inMeteor() dance.)

  // For now, we save() the capability and then dig through ApiTokens to find where it leads.
  // TODO(cleanup): In theory we should be using something like CapabilityServerSet, but it is
  //   not available in Javascript yet and even if it were, it wouldn't work in the case where
  //   there are multiple front-end replicas, since the capability could be on a different
  //   replica.

  return cap.castAs(SystemPersistent).save({ frontend: null }).then(saveResult => {
    return inMeteor(() => {
      const tokenId = hashSturdyRef(saveResult.sturdyRef);
      let tokenInfo = ApiTokens.findOne(tokenId);

      // Delete the token now since it's not needed.
      ApiTokens.remove(tokenId);

      for (;;) {
        if (!tokenInfo) throw new Error("missing token?");
        if (!tokenInfo.parentToken) break;
        tokenInfo = ApiTokens.findOne(tokenInfo.parentToken);
      }

      if (!tokenInfo.frontendRef || !tokenInfo.frontendRef[type]) {
        throw new Error("not a " + type + " capability");
      }

      return callback(tokenInfo.frontendRef[type]);
    });
  });
};
