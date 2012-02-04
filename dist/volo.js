#!/usr/bin/env node

/**
 * @license volo 0.0.4+ Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */

var voloVersion = '0.0.4+';

/** vim: et:ts=4:sw=4:sts=4
 * @license RequireJS 1.0.5 Copyright (c) 2010-2012, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/jrburke/requirejs for details
 */
/*jslint strict: false, plusplus: false, sub: true */
/*global window, navigator, document, importScripts, jQuery, setTimeout, opera */

var requirejs, require, define;
(function () {
    //Change this version number for each release.
    var version = "1.0.5",
        commentRegExp = /(\/\*([\s\S]*?)\*\/|([^:]|^)\/\/(.*)$)/mg,
        cjsRequireRegExp = /require\(\s*["']([^'"\s]+)["']\s*\)/g,
        currDirRegExp = /^\.\//,
        jsSuffixRegExp = /\.js$/,
        ostring = Object.prototype.toString,
        ap = Array.prototype,
        aps = ap.slice,
        apsp = ap.splice,
        isBrowser = !!(typeof window !== "undefined" && navigator && document),
        isWebWorker = !isBrowser && typeof importScripts !== "undefined",
        //PS3 indicates loaded and complete, but need to wait for complete
        //specifically. Sequence is "loading", "loaded", execution,
        // then "complete". The UA check is unfortunate, but not sure how
        //to feature test w/o causing perf issues.
        readyRegExp = isBrowser && navigator.platform === 'PLAYSTATION 3' ?
                      /^complete$/ : /^(complete|loaded)$/,
        defContextName = "_",
        //Oh the tragedy, detecting opera. See the usage of isOpera for reason.
        isOpera = typeof opera !== "undefined" && opera.toString() === "[object Opera]",
        empty = {},
        contexts = {},
        globalDefQueue = [],
        interactiveScript = null,
        checkLoadedDepth = 0,
        useInteractive = false,
        reservedDependencies = {
            require: true,
            module: true,
            exports: true
        },
        req, cfg = {}, currentlyAddingScript, s, head, baseElement, scripts, script,
        src, subPath, mainScript, dataMain, globalI, ctx, jQueryCheck, checkLoadedTimeoutId;

    function isFunction(it) {
        return ostring.call(it) === "[object Function]";
    }

    function isArray(it) {
        return ostring.call(it) === "[object Array]";
    }

    /**
     * Simple function to mix in properties from source into target,
     * but only if target does not already have a property of the same name.
     * This is not robust in IE for transferring methods that match
     * Object.prototype names, but the uses of mixin here seem unlikely to
     * trigger a problem related to that.
     */
    function mixin(target, source, force) {
        for (var prop in source) {
            if (!(prop in empty) && (!(prop in target) || force)) {
                target[prop] = source[prop];
            }
        }
        return req;
    }

    /**
     * Constructs an error with a pointer to an URL with more information.
     * @param {String} id the error ID that maps to an ID on a web page.
     * @param {String} message human readable error.
     * @param {Error} [err] the original error, if there is one.
     *
     * @returns {Error}
     */
    function makeError(id, msg, err) {
        var e = new Error(msg + '\nhttp://requirejs.org/docs/errors.html#' + id);
        if (err) {
            e.originalError = err;
        }
        return e;
    }

    /**
     * Used to set up package paths from a packagePaths or packages config object.
     * @param {Object} pkgs the object to store the new package config
     * @param {Array} currentPackages an array of packages to configure
     * @param {String} [dir] a prefix dir to use.
     */
    function configurePackageDir(pkgs, currentPackages, dir) {
        var i, location, pkgObj;

        for (i = 0; (pkgObj = currentPackages[i]); i++) {
            pkgObj = typeof pkgObj === "string" ? { name: pkgObj } : pkgObj;
            location = pkgObj.location;

            //Add dir to the path, but avoid paths that start with a slash
            //or have a colon (indicates a protocol)
            if (dir && (!location || (location.indexOf("/") !== 0 && location.indexOf(":") === -1))) {
                location = dir + "/" + (location || pkgObj.name);
            }

            //Create a brand new object on pkgs, since currentPackages can
            //be passed in again, and config.pkgs is the internal transformed
            //state for all package configs.
            pkgs[pkgObj.name] = {
                name: pkgObj.name,
                location: location || pkgObj.name,
                //Remove leading dot in main, so main paths are normalized,
                //and remove any trailing .js, since different package
                //envs have different conventions: some use a module name,
                //some use a file name.
                main: (pkgObj.main || "main")
                      .replace(currDirRegExp, '')
                      .replace(jsSuffixRegExp, '')
            };
        }
    }

    /**
     * jQuery 1.4.3-1.5.x use a readyWait/ready() pairing to hold DOM
     * ready callbacks, but jQuery 1.6 supports a holdReady() API instead.
     * At some point remove the readyWait/ready() support and just stick
     * with using holdReady.
     */
    function jQueryHoldReady($, shouldHold) {
        if ($.holdReady) {
            $.holdReady(shouldHold);
        } else if (shouldHold) {
            $.readyWait += 1;
        } else {
            $.ready(true);
        }
    }

    if (typeof define !== "undefined") {
        //If a define is already in play via another AMD loader,
        //do not overwrite.
        return;
    }

    if (typeof requirejs !== "undefined") {
        if (isFunction(requirejs)) {
            //Do not overwrite and existing requirejs instance.
            return;
        } else {
            cfg = requirejs;
            requirejs = undefined;
        }
    }

    //Allow for a require config object
    if (typeof require !== "undefined" && !isFunction(require)) {
        //assume it is a config object.
        cfg = require;
        require = undefined;
    }

    /**
     * Creates a new context for use in require and define calls.
     * Handle most of the heavy lifting. Do not want to use an object
     * with prototype here to avoid using "this" in require, in case it
     * needs to be used in more super secure envs that do not want this.
     * Also there should not be that many contexts in the page. Usually just
     * one for the default context, but could be extra for multiversion cases
     * or if a package needs a special context for a dependency that conflicts
     * with the standard context.
     */
    function newContext(contextName) {
        var context, resume,
            config = {
                waitSeconds: 7,
                baseUrl: "./",
                paths: {},
                pkgs: {},
                catchError: {}
            },
            defQueue = [],
            specified = {
                "require": true,
                "exports": true,
                "module": true
            },
            urlMap = {},
            defined = {},
            loaded = {},
            waiting = {},
            waitAry = [],
            urlFetched = {},
            managerCounter = 0,
            managerCallbacks = {},
            plugins = {},
            //Used to indicate which modules in a build scenario
            //need to be full executed.
            needFullExec = {},
            fullExec = {},
            resumeDepth = 0;

        /**
         * Trims the . and .. from an array of path segments.
         * It will keep a leading path segment if a .. will become
         * the first path segment, to help with module name lookups,
         * which act like paths, but can be remapped. But the end result,
         * all paths that use this function should look normalized.
         * NOTE: this method MODIFIES the input array.
         * @param {Array} ary the array of path segments.
         */
        function trimDots(ary) {
            var i, part;
            for (i = 0; (part = ary[i]); i++) {
                if (part === ".") {
                    ary.splice(i, 1);
                    i -= 1;
                } else if (part === "..") {
                    if (i === 1 && (ary[2] === '..' || ary[0] === '..')) {
                        //End of the line. Keep at least one non-dot
                        //path segment at the front so it can be mapped
                        //correctly to disk. Otherwise, there is likely
                        //no path mapping for a path starting with '..'.
                        //This can still fail, but catches the most reasonable
                        //uses of ..
                        break;
                    } else if (i > 0) {
                        ary.splice(i - 1, 2);
                        i -= 2;
                    }
                }
            }
        }

        /**
         * Given a relative module name, like ./something, normalize it to
         * a real name that can be mapped to a path.
         * @param {String} name the relative name
         * @param {String} baseName a real name that the name arg is relative
         * to.
         * @returns {String} normalized name
         */
        function normalize(name, baseName) {
            var pkgName, pkgConfig;

            //Adjust any relative paths.
            if (name && name.charAt(0) === ".") {
                //If have a base name, try to normalize against it,
                //otherwise, assume it is a top-level require that will
                //be relative to baseUrl in the end.
                if (baseName) {
                    if (config.pkgs[baseName]) {
                        //If the baseName is a package name, then just treat it as one
                        //name to concat the name with.
                        baseName = [baseName];
                    } else {
                        //Convert baseName to array, and lop off the last part,
                        //so that . matches that "directory" and not name of the baseName's
                        //module. For instance, baseName of "one/two/three", maps to
                        //"one/two/three.js", but we want the directory, "one/two" for
                        //this normalization.
                        baseName = baseName.split("/");
                        baseName = baseName.slice(0, baseName.length - 1);
                    }

                    name = baseName.concat(name.split("/"));
                    trimDots(name);

                    //Some use of packages may use a . path to reference the
                    //"main" module name, so normalize for that.
                    pkgConfig = config.pkgs[(pkgName = name[0])];
                    name = name.join("/");
                    if (pkgConfig && name === pkgName + '/' + pkgConfig.main) {
                        name = pkgName;
                    }
                } else if (name.indexOf("./") === 0) {
                    // No baseName, so this is ID is resolved relative
                    // to baseUrl, pull off the leading dot.
                    name = name.substring(2);
                }
            }
            return name;
        }

        /**
         * Creates a module mapping that includes plugin prefix, module
         * name, and path. If parentModuleMap is provided it will
         * also normalize the name via require.normalize()
         *
         * @param {String} name the module name
         * @param {String} [parentModuleMap] parent module map
         * for the module name, used to resolve relative names.
         *
         * @returns {Object}
         */
        function makeModuleMap(name, parentModuleMap) {
            var index = name ? name.indexOf("!") : -1,
                prefix = null,
                parentName = parentModuleMap ? parentModuleMap.name : null,
                originalName = name,
                normalizedName, url, pluginModule;

            if (index !== -1) {
                prefix = name.substring(0, index);
                name = name.substring(index + 1, name.length);
            }

            if (prefix) {
                prefix = normalize(prefix, parentName);
            }

            //Account for relative paths if there is a base name.
            if (name) {
                if (prefix) {
                    pluginModule = defined[prefix];
                    if (pluginModule && pluginModule.normalize) {
                        //Plugin is loaded, use its normalize method.
                        normalizedName = pluginModule.normalize(name, function (name) {
                            return normalize(name, parentName);
                        });
                    } else {
                        normalizedName = normalize(name, parentName);
                    }
                } else {
                    //A regular module.
                    normalizedName = normalize(name, parentName);

                    url = urlMap[normalizedName];
                    if (!url) {
                        //Calculate url for the module, if it has a name.
                        //Use name here since nameToUrl also calls normalize,
                        //and for relative names that are outside the baseUrl
                        //this causes havoc. Was thinking of just removing
                        //parentModuleMap to avoid extra normalization, but
                        //normalize() still does a dot removal because of
                        //issue #142, so just pass in name here and redo
                        //the normalization. Paths outside baseUrl are just
                        //messy to support.
                        url = context.nameToUrl(name, null, parentModuleMap);

                        //Store the URL mapping for later.
                        urlMap[normalizedName] = url;
                    }
                }
            }

            return {
                prefix: prefix,
                name: normalizedName,
                parentMap: parentModuleMap,
                url: url,
                originalName: originalName,
                fullName: prefix ? prefix + "!" + (normalizedName || '') : normalizedName
            };
        }

        /**
         * Determine if priority loading is done. If so clear the priorityWait
         */
        function isPriorityDone() {
            var priorityDone = true,
                priorityWait = config.priorityWait,
                priorityName, i;
            if (priorityWait) {
                for (i = 0; (priorityName = priorityWait[i]); i++) {
                    if (!loaded[priorityName]) {
                        priorityDone = false;
                        break;
                    }
                }
                if (priorityDone) {
                    delete config.priorityWait;
                }
            }
            return priorityDone;
        }

        function makeContextModuleFunc(func, relModuleMap, enableBuildCallback) {
            return function () {
                //A version of a require function that passes a moduleName
                //value for items that may need to
                //look up paths relative to the moduleName
                var args = aps.call(arguments, 0), lastArg;
                if (enableBuildCallback &&
                    isFunction((lastArg = args[args.length - 1]))) {
                    lastArg.__requireJsBuild = true;
                }
                args.push(relModuleMap);
                return func.apply(null, args);
            };
        }

        /**
         * Helper function that creates a require function object to give to
         * modules that ask for it as a dependency. It needs to be specific
         * per module because of the implication of path mappings that may
         * need to be relative to the module name.
         */
        function makeRequire(relModuleMap, enableBuildCallback, altRequire) {
            var modRequire = makeContextModuleFunc(altRequire || context.require, relModuleMap, enableBuildCallback);

            mixin(modRequire, {
                nameToUrl: makeContextModuleFunc(context.nameToUrl, relModuleMap),
                toUrl: makeContextModuleFunc(context.toUrl, relModuleMap),
                defined: makeContextModuleFunc(context.requireDefined, relModuleMap),
                specified: makeContextModuleFunc(context.requireSpecified, relModuleMap),
                isBrowser: req.isBrowser
            });
            return modRequire;
        }

        /*
         * Queues a dependency for checking after the loader is out of a
         * "paused" state, for example while a script file is being loaded
         * in the browser, where it may have many modules defined in it.
         */
        function queueDependency(manager) {
            context.paused.push(manager);
        }

        function execManager(manager) {
            var i, ret, err, errFile, errModuleTree,
                cb = manager.callback,
                map = manager.map,
                fullName = map.fullName,
                args = manager.deps,
                listeners = manager.listeners,
                cjsModule;

            //Call the callback to define the module, if necessary.
            if (cb && isFunction(cb)) {
                if (config.catchError.define) {
                    try {
                        ret = req.execCb(fullName, manager.callback, args, defined[fullName]);
                    } catch (e) {
                        err = e;
                    }
                } else {
                    ret = req.execCb(fullName, manager.callback, args, defined[fullName]);
                }

                if (fullName) {
                    //If setting exports via "module" is in play,
                    //favor that over return value and exports. After that,
                    //favor a non-undefined return value over exports use.
                    cjsModule = manager.cjsModule;
                    if (cjsModule &&
                        cjsModule.exports !== undefined &&
                        //Make sure it is not already the exports value
                        cjsModule.exports !== defined[fullName]) {
                        ret = defined[fullName] = manager.cjsModule.exports;
                    } else if (ret === undefined && manager.usingExports) {
                        //exports already set the defined value.
                        ret = defined[fullName];
                    } else {
                        //Use the return value from the function.
                        defined[fullName] = ret;
                        //If this module needed full execution in a build
                        //environment, mark that now.
                        if (needFullExec[fullName]) {
                            fullExec[fullName] = true;
                        }
                    }
                }
            } else if (fullName) {
                //May just be an object definition for the module. Only
                //worry about defining if have a module name.
                ret = defined[fullName] = cb;

                //If this module needed full execution in a build
                //environment, mark that now.
                if (needFullExec[fullName]) {
                    fullExec[fullName] = true;
                }
            }

            //Clean up waiting. Do this before error calls, and before
            //calling back listeners, so that bookkeeping is correct
            //in the event of an error and error is reported in correct order,
            //since the listeners will likely have errors if the
            //onError function does not throw.
            if (waiting[manager.id]) {
                delete waiting[manager.id];
                manager.isDone = true;
                context.waitCount -= 1;
                if (context.waitCount === 0) {
                    //Clear the wait array used for cycles.
                    waitAry = [];
                }
            }

            //Do not need to track manager callback now that it is defined.
            delete managerCallbacks[fullName];

            //Allow instrumentation like the optimizer to know the order
            //of modules executed and their dependencies.
            if (req.onResourceLoad && !manager.placeholder) {
                req.onResourceLoad(context, map, manager.depArray);
            }

            if (err) {
                errFile = (fullName ? makeModuleMap(fullName).url : '') ||
                           err.fileName || err.sourceURL;
                errModuleTree = err.moduleTree;
                err = makeError('defineerror', 'Error evaluating ' +
                                'module "' + fullName + '" at location "' +
                                errFile + '":\n' +
                                err + '\nfileName:' + errFile +
                                '\nlineNumber: ' + (err.lineNumber || err.line), err);
                err.moduleName = fullName;
                err.moduleTree = errModuleTree;
                return req.onError(err);
            }

            //Let listeners know of this manager's value.
            for (i = 0; (cb = listeners[i]); i++) {
                cb(ret);
            }

            return undefined;
        }

        /**
         * Helper that creates a callack function that is called when a dependency
         * is ready, and sets the i-th dependency for the manager as the
         * value passed to the callback generated by this function.
         */
        function makeArgCallback(manager, i) {
            return function (value) {
                //Only do the work if it has not been done
                //already for a dependency. Cycle breaking
                //logic in forceExec could mean this function
                //is called more than once for a given dependency.
                if (!manager.depDone[i]) {
                    manager.depDone[i] = true;
                    manager.deps[i] = value;
                    manager.depCount -= 1;
                    if (!manager.depCount) {
                        //All done, execute!
                        execManager(manager);
                    }
                }
            };
        }

        function callPlugin(pluginName, depManager) {
            var map = depManager.map,
                fullName = map.fullName,
                name = map.name,
                plugin = plugins[pluginName] ||
                        (plugins[pluginName] = defined[pluginName]),
                load;

            //No need to continue if the manager is already
            //in the process of loading.
            if (depManager.loading) {
                return;
            }
            depManager.loading = true;

            load = function (ret) {
                depManager.callback = function () {
                    return ret;
                };
                execManager(depManager);

                loaded[depManager.id] = true;

                //The loading of this plugin
                //might have placed other things
                //in the paused queue. In particular,
                //a loader plugin that depends on
                //a different plugin loaded resource.
                resume();
            };

            //Allow plugins to load other code without having to know the
            //context or how to "complete" the load.
            load.fromText = function (moduleName, text) {
                /*jslint evil: true */
                var hasInteractive = useInteractive;

                //Indicate a the module is in process of loading.
                loaded[moduleName] = false;
                context.scriptCount += 1;

                //Indicate this is not a "real" module, so do not track it
                //for builds, it does not map to a real file.
                context.fake[moduleName] = true;

                //Turn off interactive script matching for IE for any define
                //calls in the text, then turn it back on at the end.
                if (hasInteractive) {
                    useInteractive = false;
                }

                req.exec(text);

                if (hasInteractive) {
                    useInteractive = true;
                }

                //Support anonymous modules.
                context.completeLoad(moduleName);
            };

            //No need to continue if the plugin value has already been
            //defined by a build.
            if (fullName in defined) {
                load(defined[fullName]);
            } else {
                //Use parentName here since the plugin's name is not reliable,
                //could be some weird string with no path that actually wants to
                //reference the parentName's path.
                plugin.load(name, makeRequire(map.parentMap, true, function (deps, cb) {
                    var moduleDeps = [],
                        i, dep, depMap;
                    //Convert deps to full names and hold on to them
                    //for reference later, when figuring out if they
                    //are blocked by a circular dependency.
                    for (i = 0; (dep = deps[i]); i++) {
                        depMap = makeModuleMap(dep, map.parentMap);
                        deps[i] = depMap.fullName;
                        if (!depMap.prefix) {
                            moduleDeps.push(deps[i]);
                        }
                    }
                    depManager.moduleDeps = (depManager.moduleDeps || []).concat(moduleDeps);
                    return context.require(deps, cb);
                }), load, config);
            }
        }

        /**
         * Adds the manager to the waiting queue. Only fully
         * resolved items should be in the waiting queue.
         */
        function addWait(manager) {
            if (!waiting[manager.id]) {
                waiting[manager.id] = manager;
                waitAry.push(manager);
                context.waitCount += 1;
            }
        }

        /**
         * Function added to every manager object. Created out here
         * to avoid new function creation for each manager instance.
         */
        function managerAdd(cb) {
            this.listeners.push(cb);
        }

        function getManager(map, shouldQueue) {
            var fullName = map.fullName,
                prefix = map.prefix,
                plugin = prefix ? plugins[prefix] ||
                                (plugins[prefix] = defined[prefix]) : null,
                manager, created, pluginManager, prefixMap;

            if (fullName) {
                manager = managerCallbacks[fullName];
            }

            if (!manager) {
                created = true;
                manager = {
                    //ID is just the full name, but if it is a plugin resource
                    //for a plugin that has not been loaded,
                    //then add an ID counter to it.
                    id: (prefix && !plugin ?
                        (managerCounter++) + '__p@:' : '') +
                        (fullName || '__r@' + (managerCounter++)),
                    map: map,
                    depCount: 0,
                    depDone: [],
                    depCallbacks: [],
                    deps: [],
                    listeners: [],
                    add: managerAdd
                };

                specified[manager.id] = true;

                //Only track the manager/reuse it if this is a non-plugin
                //resource. Also only track plugin resources once
                //the plugin has been loaded, and so the fullName is the
                //true normalized value.
                if (fullName && (!prefix || plugins[prefix])) {
                    managerCallbacks[fullName] = manager;
                }
            }

            //If there is a plugin needed, but it is not loaded,
            //first load the plugin, then continue on.
            if (prefix && !plugin) {
                prefixMap = makeModuleMap(prefix);

                //Clear out defined and urlFetched if the plugin was previously
                //loaded/defined, but not as full module (as in a build
                //situation). However, only do this work if the plugin is in
                //defined but does not have a module export value.
                if (prefix in defined && !defined[prefix]) {
                    delete defined[prefix];
                    delete urlFetched[prefixMap.url];
                }

                pluginManager = getManager(prefixMap, true);
                pluginManager.add(function (plugin) {
                    //Create a new manager for the normalized
                    //resource ID and have it call this manager when
                    //done.
                    var newMap = makeModuleMap(map.originalName, map.parentMap),
                        normalizedManager = getManager(newMap, true);

                    //Indicate this manager is a placeholder for the real,
                    //normalized thing. Important for when trying to map
                    //modules and dependencies, for instance, in a build.
                    manager.placeholder = true;

                    normalizedManager.add(function (resource) {
                        manager.callback = function () {
                            return resource;
                        };
                        execManager(manager);
                    });
                });
            } else if (created && shouldQueue) {
                //Indicate the resource is not loaded yet if it is to be
                //queued.
                loaded[manager.id] = false;
                queueDependency(manager);
                addWait(manager);
            }

            return manager;
        }

        function main(inName, depArray, callback, relModuleMap) {
            var moduleMap = makeModuleMap(inName, relModuleMap),
                name = moduleMap.name,
                fullName = moduleMap.fullName,
                manager = getManager(moduleMap),
                id = manager.id,
                deps = manager.deps,
                i, depArg, depName, depPrefix, cjsMod;

            if (fullName) {
                //If module already defined for context, or already loaded,
                //then leave. Also leave if jQuery is registering but it does
                //not match the desired version number in the config.
                if (fullName in defined || loaded[id] === true ||
                    (fullName === "jquery" && config.jQuery &&
                     config.jQuery !== callback().fn.jquery)) {
                    return;
                }

                //Set specified/loaded here for modules that are also loaded
                //as part of a layer, where onScriptLoad is not fired
                //for those cases. Do this after the inline define and
                //dependency tracing is done.
                specified[id] = true;
                loaded[id] = true;

                //If module is jQuery set up delaying its dom ready listeners.
                if (fullName === "jquery" && callback) {
                    jQueryCheck(callback());
                }
            }

            //Attach real depArray and callback to the manager. Do this
            //only if the module has not been defined already, so do this after
            //the fullName checks above. IE can call main() more than once
            //for a module.
            manager.depArray = depArray;
            manager.callback = callback;

            //Add the dependencies to the deps field, and register for callbacks
            //on the dependencies.
            for (i = 0; i < depArray.length; i++) {
                depArg = depArray[i];
                //There could be cases like in IE, where a trailing comma will
                //introduce a null dependency, so only treat a real dependency
                //value as a dependency.
                if (depArg) {
                    //Split the dependency name into plugin and name parts
                    depArg = makeModuleMap(depArg, (name ? moduleMap : relModuleMap));
                    depName = depArg.fullName;
                    depPrefix = depArg.prefix;

                    //Fix the name in depArray to be just the name, since
                    //that is how it will be called back later.
                    depArray[i] = depName;

                    //Fast path CommonJS standard dependencies.
                    if (depName === "require") {
                        deps[i] = makeRequire(moduleMap);
                    } else if (depName === "exports") {
                        //CommonJS module spec 1.1
                        deps[i] = defined[fullName] = {};
                        manager.usingExports = true;
                    } else if (depName === "module") {
                        //CommonJS module spec 1.1
                        manager.cjsModule = cjsMod = deps[i] = {
                            id: name,
                            uri: name ? context.nameToUrl(name, null, relModuleMap) : undefined,
                            exports: defined[fullName]
                        };
                    } else if (depName in defined && !(depName in waiting) &&
                               (!(fullName in needFullExec) ||
                                (fullName in needFullExec && fullExec[depName]))) {
                        //Module already defined, and not in a build situation
                        //where the module is a something that needs full
                        //execution and this dependency has not been fully
                        //executed. See r.js's requirePatch.js for more info
                        //on fullExec.
                        deps[i] = defined[depName];
                    } else {
                        //Mark this dependency as needing full exec if
                        //the current module needs full exec.
                        if (fullName in needFullExec) {
                            needFullExec[depName] = true;
                            //Reset state so fully executed code will get
                            //picked up correctly.
                            delete defined[depName];
                            urlFetched[depArg.url] = false;
                        }

                        //Either a resource that is not loaded yet, or a plugin
                        //resource for either a plugin that has not
                        //loaded yet.
                        manager.depCount += 1;
                        manager.depCallbacks[i] = makeArgCallback(manager, i);
                        getManager(depArg, true).add(manager.depCallbacks[i]);
                    }
                }
            }

            //Do not bother tracking the manager if it is all done.
            if (!manager.depCount) {
                //All done, execute!
                execManager(manager);
            } else {
                addWait(manager);
            }
        }

        /**
         * Convenience method to call main for a define call that was put on
         * hold in the defQueue.
         */
        function callDefMain(args) {
            main.apply(null, args);
        }

        /**
         * jQuery 1.4.3+ supports ways to hold off calling
         * calling jQuery ready callbacks until all scripts are loaded. Be sure
         * to track it if the capability exists.. Also, since jQuery 1.4.3 does
         * not register as a module, need to do some global inference checking.
         * Even if it does register as a module, not guaranteed to be the precise
         * name of the global. If a jQuery is tracked for this context, then go
         * ahead and register it as a module too, if not already in process.
         */
        jQueryCheck = function (jqCandidate) {
            if (!context.jQuery) {
                var $ = jqCandidate || (typeof jQuery !== "undefined" ? jQuery : null);

                if ($) {
                    //If a specific version of jQuery is wanted, make sure to only
                    //use this jQuery if it matches.
                    if (config.jQuery && $.fn.jquery !== config.jQuery) {
                        return;
                    }

                    if ("holdReady" in $ || "readyWait" in $) {
                        context.jQuery = $;

                        //Manually create a "jquery" module entry if not one already
                        //or in process. Note this could trigger an attempt at
                        //a second jQuery registration, but does no harm since
                        //the first one wins, and it is the same value anyway.
                        callDefMain(["jquery", [], function () {
                            return jQuery;
                        }]);

                        //Ask jQuery to hold DOM ready callbacks.
                        if (context.scriptCount) {
                            jQueryHoldReady($, true);
                            context.jQueryIncremented = true;
                        }
                    }
                }
            }
        };

        function findCycle(manager, traced) {
            var fullName = manager.map.fullName,
                depArray = manager.depArray,
                fullyLoaded = true,
                i, depName, depManager, result;

            if (manager.isDone || !fullName || !loaded[fullName]) {
                return result;
            }

            //Found the cycle.
            if (traced[fullName]) {
                return manager;
            }

            traced[fullName] = true;

            //Trace through the dependencies.
            if (depArray) {
                for (i = 0; i < depArray.length; i++) {
                    //Some array members may be null, like if a trailing comma
                    //IE, so do the explicit [i] access and check if it has a value.
                    depName = depArray[i];
                    if (!loaded[depName] && !reservedDependencies[depName]) {
                        fullyLoaded = false;
                        break;
                    }
                    depManager = waiting[depName];
                    if (depManager && !depManager.isDone && loaded[depName]) {
                        result = findCycle(depManager, traced);
                        if (result) {
                            break;
                        }
                    }
                }
                if (!fullyLoaded) {
                    //Discard the cycle that was found, since it cannot
                    //be forced yet. Also clear this module from traced.
                    result = undefined;
                    delete traced[fullName];
                }
            }

            return result;
        }

        function forceExec(manager, traced) {
            var fullName = manager.map.fullName,
                depArray = manager.depArray,
                i, depName, depManager, prefix, prefixManager, value;


            if (manager.isDone || !fullName || !loaded[fullName]) {
                return undefined;
            }

            if (fullName) {
                if (traced[fullName]) {
                    return defined[fullName];
                }

                traced[fullName] = true;
            }

            //Trace through the dependencies.
            if (depArray) {
                for (i = 0; i < depArray.length; i++) {
                    //Some array members may be null, like if a trailing comma
                    //IE, so do the explicit [i] access and check if it has a value.
                    depName = depArray[i];
                    if (depName) {
                        //First, make sure if it is a plugin resource that the
                        //plugin is not blocked.
                        prefix = makeModuleMap(depName).prefix;
                        if (prefix && (prefixManager = waiting[prefix])) {
                            forceExec(prefixManager, traced);
                        }
                        depManager = waiting[depName];
                        if (depManager && !depManager.isDone && loaded[depName]) {
                            value = forceExec(depManager, traced);
                            manager.depCallbacks[i](value);
                        }
                    }
                }
            }

            return defined[fullName];
        }

        /**
         * Checks if all modules for a context are loaded, and if so, evaluates the
         * new ones in right dependency order.
         *
         * @private
         */
        function checkLoaded() {
            var waitInterval = config.waitSeconds * 1000,
                //It is possible to disable the wait interval by using waitSeconds of 0.
                expired = waitInterval && (context.startTime + waitInterval) < new Date().getTime(),
                noLoads = "", hasLoadedProp = false, stillLoading = false,
                cycleDeps = [],
                i, prop, err, manager, cycleManager, moduleDeps;

            //If there are items still in the paused queue processing wait.
            //This is particularly important in the sync case where each paused
            //item is processed right away but there may be more waiting.
            if (context.pausedCount > 0) {
                return undefined;
            }

            //Determine if priority loading is done. If so clear the priority. If
            //not, then do not check
            if (config.priorityWait) {
                if (isPriorityDone()) {
                    //Call resume, since it could have
                    //some waiting dependencies to trace.
                    resume();
                } else {
                    return undefined;
                }
            }

            //See if anything is still in flight.
            for (prop in loaded) {
                if (!(prop in empty)) {
                    hasLoadedProp = true;
                    if (!loaded[prop]) {
                        if (expired) {
                            noLoads += prop + " ";
                        } else {
                            stillLoading = true;
                            if (prop.indexOf('!') === -1) {
                                //No reason to keep looking for unfinished
                                //loading. If the only stillLoading is a
                                //plugin resource though, keep going,
                                //because it may be that a plugin resource
                                //is waiting on a non-plugin cycle.
                                cycleDeps = [];
                                break;
                            } else {
                                moduleDeps = managerCallbacks[prop] && managerCallbacks[prop].moduleDeps;
                                if (moduleDeps) {
                                    cycleDeps.push.apply(cycleDeps, moduleDeps);
                                }
                            }
                        }
                    }
                }
            }

            //Check for exit conditions.
            if (!hasLoadedProp && !context.waitCount) {
                //If the loaded object had no items, then the rest of
                //the work below does not need to be done.
                return undefined;
            }
            if (expired && noLoads) {
                //If wait time expired, throw error of unloaded modules.
                err = makeError("timeout", "Load timeout for modules: " + noLoads);
                err.requireType = "timeout";
                err.requireModules = noLoads;
                return req.onError(err);
            }

            //If still loading but a plugin is waiting on a regular module cycle
            //break the cycle.
            if (stillLoading && cycleDeps.length) {
                for (i = 0; (manager = waiting[cycleDeps[i]]); i++) {
                    if ((cycleManager = findCycle(manager, {}))) {
                        forceExec(cycleManager, {});
                        break;
                    }
                }

            }

            //If still waiting on loads, and the waiting load is something
            //other than a plugin resource, or there are still outstanding
            //scripts, then just try back later.
            if (!expired && (stillLoading || context.scriptCount)) {
                //Something is still waiting to load. Wait for it, but only
                //if a timeout is not already in effect.
                if ((isBrowser || isWebWorker) && !checkLoadedTimeoutId) {
                    checkLoadedTimeoutId = setTimeout(function () {
                        checkLoadedTimeoutId = 0;
                        checkLoaded();
                    }, 50);
                }
                return undefined;
            }

            //If still have items in the waiting cue, but all modules have
            //been loaded, then it means there are some circular dependencies
            //that need to be broken.
            //However, as a waiting thing is fired, then it can add items to
            //the waiting cue, and those items should not be fired yet, so
            //make sure to redo the checkLoaded call after breaking a single
            //cycle, if nothing else loaded then this logic will pick it up
            //again.
            if (context.waitCount) {
                //Cycle through the waitAry, and call items in sequence.
                for (i = 0; (manager = waitAry[i]); i++) {
                    forceExec(manager, {});
                }

                //If anything got placed in the paused queue, run it down.
                if (context.paused.length) {
                    resume();
                }

                //Only allow this recursion to a certain depth. Only
                //triggered by errors in calling a module in which its
                //modules waiting on it cannot finish loading, or some circular
                //dependencies that then may add more dependencies.
                //The value of 5 is a bit arbitrary. Hopefully just one extra
                //pass, or two for the case of circular dependencies generating
                //more work that gets resolved in the sync node case.
                if (checkLoadedDepth < 5) {
                    checkLoadedDepth += 1;
                    checkLoaded();
                }
            }

            checkLoadedDepth = 0;

            //Check for DOM ready, and nothing is waiting across contexts.
            req.checkReadyState();

            return undefined;
        }

        /**
         * Resumes tracing of dependencies and then checks if everything is loaded.
         */
        resume = function () {
            var manager, map, url, i, p, args, fullName;

            //Any defined modules in the global queue, intake them now.
            context.takeGlobalQueue();

            resumeDepth += 1;

            if (context.scriptCount <= 0) {
                //Synchronous envs will push the number below zero with the
                //decrement above, be sure to set it back to zero for good measure.
                //require() calls that also do not end up loading scripts could
                //push the number negative too.
                context.scriptCount = 0;
            }

            //Make sure any remaining defQueue items get properly processed.
            while (defQueue.length) {
                args = defQueue.shift();
                if (args[0] === null) {
                    return req.onError(makeError('mismatch', 'Mismatched anonymous define() module: ' + args[args.length - 1]));
                } else {
                    callDefMain(args);
                }
            }

            //Skip the resume of paused dependencies
            //if current context is in priority wait.
            if (!config.priorityWait || isPriorityDone()) {
                while (context.paused.length) {
                    p = context.paused;
                    context.pausedCount += p.length;
                    //Reset paused list
                    context.paused = [];

                    for (i = 0; (manager = p[i]); i++) {
                        map = manager.map;
                        url = map.url;
                        fullName = map.fullName;

                        //If the manager is for a plugin managed resource,
                        //ask the plugin to load it now.
                        if (map.prefix) {
                            callPlugin(map.prefix, manager);
                        } else {
                            //Regular dependency.
                            if (!urlFetched[url] && !loaded[fullName]) {
                                req.load(context, fullName, url);

                                //Mark the URL as fetched, but only if it is
                                //not an empty: URL, used by the optimizer.
                                //In that case we need to be sure to call
                                //load() for each module that is mapped to
                                //empty: so that dependencies are satisfied
                                //correctly.
                                if (url.indexOf('empty:') !== 0) {
                                    urlFetched[url] = true;
                                }
                            }
                        }
                    }

                    //Move the start time for timeout forward.
                    context.startTime = (new Date()).getTime();
                    context.pausedCount -= p.length;
                }
            }

            //Only check if loaded when resume depth is 1. It is likely that
            //it is only greater than 1 in sync environments where a factory
            //function also then calls the callback-style require. In those
            //cases, the checkLoaded should not occur until the resume
            //depth is back at the top level.
            if (resumeDepth === 1) {
                checkLoaded();
            }

            resumeDepth -= 1;

            return undefined;
        };

        //Define the context object. Many of these fields are on here
        //just to make debugging easier.
        context = {
            contextName: contextName,
            config: config,
            defQueue: defQueue,
            waiting: waiting,
            waitCount: 0,
            specified: specified,
            loaded: loaded,
            urlMap: urlMap,
            urlFetched: urlFetched,
            scriptCount: 0,
            defined: defined,
            paused: [],
            pausedCount: 0,
            plugins: plugins,
            needFullExec: needFullExec,
            fake: {},
            fullExec: fullExec,
            managerCallbacks: managerCallbacks,
            makeModuleMap: makeModuleMap,
            normalize: normalize,
            /**
             * Set a configuration for the context.
             * @param {Object} cfg config object to integrate.
             */
            configure: function (cfg) {
                var paths, prop, packages, pkgs, packagePaths, requireWait;

                //Make sure the baseUrl ends in a slash.
                if (cfg.baseUrl) {
                    if (cfg.baseUrl.charAt(cfg.baseUrl.length - 1) !== "/") {
                        cfg.baseUrl += "/";
                    }
                }

                //Save off the paths and packages since they require special processing,
                //they are additive.
                paths = config.paths;
                packages = config.packages;
                pkgs = config.pkgs;

                //Mix in the config values, favoring the new values over
                //existing ones in context.config.
                mixin(config, cfg, true);

                //Adjust paths if necessary.
                if (cfg.paths) {
                    for (prop in cfg.paths) {
                        if (!(prop in empty)) {
                            paths[prop] = cfg.paths[prop];
                        }
                    }
                    config.paths = paths;
                }

                packagePaths = cfg.packagePaths;
                if (packagePaths || cfg.packages) {
                    //Convert packagePaths into a packages config.
                    if (packagePaths) {
                        for (prop in packagePaths) {
                            if (!(prop in empty)) {
                                configurePackageDir(pkgs, packagePaths[prop], prop);
                            }
                        }
                    }

                    //Adjust packages if necessary.
                    if (cfg.packages) {
                        configurePackageDir(pkgs, cfg.packages);
                    }

                    //Done with modifications, assing packages back to context config
                    config.pkgs = pkgs;
                }

                //If priority loading is in effect, trigger the loads now
                if (cfg.priority) {
                    //Hold on to requireWait value, and reset it after done
                    requireWait = context.requireWait;

                    //Allow tracing some require calls to allow the fetching
                    //of the priority config.
                    context.requireWait = false;
                    //But first, call resume to register any defined modules that may
                    //be in a data-main built file before the priority config
                    //call.
                    resume();

                    context.require(cfg.priority);

                    //Trigger a resume right away, for the case when
                    //the script with the priority load is done as part
                    //of a data-main call. In that case the normal resume
                    //call will not happen because the scriptCount will be
                    //at 1, since the script for data-main is being processed.
                    resume();

                    //Restore previous state.
                    context.requireWait = requireWait;
                    config.priorityWait = cfg.priority;
                }

                //If a deps array or a config callback is specified, then call
                //require with those args. This is useful when require is defined as a
                //config object before require.js is loaded.
                if (cfg.deps || cfg.callback) {
                    context.require(cfg.deps || [], cfg.callback);
                }
            },

            requireDefined: function (moduleName, relModuleMap) {
                return makeModuleMap(moduleName, relModuleMap).fullName in defined;
            },

            requireSpecified: function (moduleName, relModuleMap) {
                return makeModuleMap(moduleName, relModuleMap).fullName in specified;
            },

            require: function (deps, callback, relModuleMap) {
                var moduleName, fullName, moduleMap;
                if (typeof deps === "string") {
                    if (isFunction(callback)) {
                        //Invalid call
                        return req.onError(makeError("requireargs", "Invalid require call"));
                    }

                    //Synchronous access to one module. If require.get is
                    //available (as in the Node adapter), prefer that.
                    //In this case deps is the moduleName and callback is
                    //the relModuleMap
                    if (req.get) {
                        return req.get(context, deps, callback);
                    }

                    //Just return the module wanted. In this scenario, the
                    //second arg (if passed) is just the relModuleMap.
                    moduleName = deps;
                    relModuleMap = callback;

                    //Normalize module name, if it contains . or ..
                    moduleMap = makeModuleMap(moduleName, relModuleMap);
                    fullName = moduleMap.fullName;

                    if (!(fullName in defined)) {
                        return req.onError(makeError("notloaded", "Module name '" +
                                    moduleMap.fullName +
                                    "' has not been loaded yet for context: " +
                                    contextName));
                    }
                    return defined[fullName];
                }

                //Call main but only if there are dependencies or
                //a callback to call.
                if (deps && deps.length || callback) {
                    main(null, deps, callback, relModuleMap);
                }

                //If the require call does not trigger anything new to load,
                //then resume the dependency processing.
                if (!context.requireWait) {
                    while (!context.scriptCount && context.paused.length) {
                        resume();
                    }
                }
                return context.require;
            },

            /**
             * Internal method to transfer globalQueue items to this context's
             * defQueue.
             */
            takeGlobalQueue: function () {
                //Push all the globalDefQueue items into the context's defQueue
                if (globalDefQueue.length) {
                    //Array splice in the values since the context code has a
                    //local var ref to defQueue, so cannot just reassign the one
                    //on context.
                    apsp.apply(context.defQueue,
                               [context.defQueue.length - 1, 0].concat(globalDefQueue));
                    globalDefQueue = [];
                }
            },

            /**
             * Internal method used by environment adapters to complete a load event.
             * A load event could be a script load or just a load pass from a synchronous
             * load call.
             * @param {String} moduleName the name of the module to potentially complete.
             */
            completeLoad: function (moduleName) {
                var args;

                context.takeGlobalQueue();

                while (defQueue.length) {
                    args = defQueue.shift();

                    if (args[0] === null) {
                        args[0] = moduleName;
                        break;
                    } else if (args[0] === moduleName) {
                        //Found matching define call for this script!
                        break;
                    } else {
                        //Some other named define call, most likely the result
                        //of a build layer that included many define calls.
                        callDefMain(args);
                        args = null;
                    }
                }
                if (args) {
                    callDefMain(args);
                } else {
                    //A script that does not call define(), so just simulate
                    //the call for it. Special exception for jQuery dynamic load.
                    callDefMain([moduleName, [],
                                moduleName === "jquery" && typeof jQuery !== "undefined" ?
                                function () {
                                    return jQuery;
                                } : null]);
                }

                //Doing this scriptCount decrement branching because sync envs
                //need to decrement after resume, otherwise it looks like
                //loading is complete after the first dependency is fetched.
                //For browsers, it works fine to decrement after, but it means
                //the checkLoaded setTimeout 50 ms cost is taken. To avoid
                //that cost, decrement beforehand.
                if (req.isAsync) {
                    context.scriptCount -= 1;
                }
                resume();
                if (!req.isAsync) {
                    context.scriptCount -= 1;
                }
            },

            /**
             * Converts a module name + .extension into an URL path.
             * *Requires* the use of a module name. It does not support using
             * plain URLs like nameToUrl.
             */
            toUrl: function (moduleNamePlusExt, relModuleMap) {
                var index = moduleNamePlusExt.lastIndexOf("."),
                    ext = null;

                if (index !== -1) {
                    ext = moduleNamePlusExt.substring(index, moduleNamePlusExt.length);
                    moduleNamePlusExt = moduleNamePlusExt.substring(0, index);
                }

                return context.nameToUrl(moduleNamePlusExt, ext, relModuleMap);
            },

            /**
             * Converts a module name to a file path. Supports cases where
             * moduleName may actually be just an URL.
             */
            nameToUrl: function (moduleName, ext, relModuleMap) {
                var paths, pkgs, pkg, pkgPath, syms, i, parentModule, url,
                    config = context.config;

                //Normalize module name if have a base relative module name to work from.
                moduleName = normalize(moduleName, relModuleMap && relModuleMap.fullName);

                //If a colon is in the URL, it indicates a protocol is used and it is just
                //an URL to a file, or if it starts with a slash or ends with .js, it is just a plain file.
                //The slash is important for protocol-less URLs as well as full paths.
                if (req.jsExtRegExp.test(moduleName)) {
                    //Just a plain path, not module name lookup, so just return it.
                    //Add extension if it is included. This is a bit wonky, only non-.js things pass
                    //an extension, this method probably needs to be reworked.
                    url = moduleName + (ext ? ext : "");
                } else {
                    //A module that needs to be converted to a path.
                    paths = config.paths;
                    pkgs = config.pkgs;

                    syms = moduleName.split("/");
                    //For each module name segment, see if there is a path
                    //registered for it. Start with most specific name
                    //and work up from it.
                    for (i = syms.length; i > 0; i--) {
                        parentModule = syms.slice(0, i).join("/");
                        if (paths[parentModule]) {
                            syms.splice(0, i, paths[parentModule]);
                            break;
                        } else if ((pkg = pkgs[parentModule])) {
                            //If module name is just the package name, then looking
                            //for the main module.
                            if (moduleName === pkg.name) {
                                pkgPath = pkg.location + '/' + pkg.main;
                            } else {
                                pkgPath = pkg.location;
                            }
                            syms.splice(0, i, pkgPath);
                            break;
                        }
                    }

                    //Join the path parts together, then figure out if baseUrl is needed.
                    url = syms.join("/") + (ext || ".js");
                    url = (url.charAt(0) === '/' || url.match(/^\w+:/) ? "" : config.baseUrl) + url;
                }

                return config.urlArgs ? url +
                                        ((url.indexOf('?') === -1 ? '?' : '&') +
                                         config.urlArgs) : url;
            }
        };

        //Make these visible on the context so can be called at the very
        //end of the file to bootstrap
        context.jQueryCheck = jQueryCheck;
        context.resume = resume;

        return context;
    }

    /**
     * Main entry point.
     *
     * If the only argument to require is a string, then the module that
     * is represented by that string is fetched for the appropriate context.
     *
     * If the first argument is an array, then it will be treated as an array
     * of dependency string names to fetch. An optional function callback can
     * be specified to execute when all of those dependencies are available.
     *
     * Make a local req variable to help Caja compliance (it assumes things
     * on a require that are not standardized), and to give a short
     * name for minification/local scope use.
     */
    req = requirejs = function (deps, callback) {

        //Find the right context, use default
        var contextName = defContextName,
            context, config;

        // Determine if have config object in the call.
        if (!isArray(deps) && typeof deps !== "string") {
            // deps is a config object
            config = deps;
            if (isArray(callback)) {
                // Adjust args if there are dependencies
                deps = callback;
                callback = arguments[2];
            } else {
                deps = [];
            }
        }

        if (config && config.context) {
            contextName = config.context;
        }

        context = contexts[contextName] ||
                  (contexts[contextName] = newContext(contextName));

        if (config) {
            context.configure(config);
        }

        return context.require(deps, callback);
    };

    /**
     * Support require.config() to make it easier to cooperate with other
     * AMD loaders on globally agreed names.
     */
    req.config = function (config) {
        return req(config);
    };

    /**
     * Export require as a global, but only if it does not already exist.
     */
    if (!require) {
        require = req;
    }

    /**
     * Global require.toUrl(), to match global require, mostly useful
     * for debugging/work in the global space.
     */
    req.toUrl = function (moduleNamePlusExt) {
        return contexts[defContextName].toUrl(moduleNamePlusExt);
    };

    req.version = version;

    //Used to filter out dependencies that are already paths.
    req.jsExtRegExp = /^\/|:|\?|\.js$/;
    s = req.s = {
        contexts: contexts,
        //Stores a list of URLs that should not get async script tag treatment.
        skipAsync: {}
    };

    req.isAsync = req.isBrowser = isBrowser;
    if (isBrowser) {
        head = s.head = document.getElementsByTagName("head")[0];
        //If BASE tag is in play, using appendChild is a problem for IE6.
        //When that browser dies, this can be removed. Details in this jQuery bug:
        //http://dev.jquery.com/ticket/2709
        baseElement = document.getElementsByTagName("base")[0];
        if (baseElement) {
            head = s.head = baseElement.parentNode;
        }
    }

    /**
     * Any errors that require explicitly generates will be passed to this
     * function. Intercept/override it if you want custom error handling.
     * @param {Error} err the error object.
     */
    req.onError = function (err) {
        throw err;
    };

    /**
     * Does the request to load a module for the browser case.
     * Make this a separate function to allow other environments
     * to override it.
     *
     * @param {Object} context the require context to find state.
     * @param {String} moduleName the name of the module.
     * @param {Object} url the URL to the module.
     */
    req.load = function (context, moduleName, url) {
        req.resourcesReady(false);

        context.scriptCount += 1;
        req.attach(url, context, moduleName);

        //If tracking a jQuery, then make sure its ready callbacks
        //are put on hold to prevent its ready callbacks from
        //triggering too soon.
        if (context.jQuery && !context.jQueryIncremented) {
            jQueryHoldReady(context.jQuery, true);
            context.jQueryIncremented = true;
        }
    };

    function getInteractiveScript() {
        var scripts, i, script;
        if (interactiveScript && interactiveScript.readyState === 'interactive') {
            return interactiveScript;
        }

        scripts = document.getElementsByTagName('script');
        for (i = scripts.length - 1; i > -1 && (script = scripts[i]); i--) {
            if (script.readyState === 'interactive') {
                return (interactiveScript = script);
            }
        }

        return null;
    }

    /**
     * The function that handles definitions of modules. Differs from
     * require() in that a string for the module should be the first argument,
     * and the function to execute after dependencies are loaded should
     * return a value to define the module corresponding to the first argument's
     * name.
     */
    define = function (name, deps, callback) {
        var node, context;

        //Allow for anonymous functions
        if (typeof name !== 'string') {
            //Adjust args appropriately
            callback = deps;
            deps = name;
            name = null;
        }

        //This module may not have dependencies
        if (!isArray(deps)) {
            callback = deps;
            deps = [];
        }

        //If no name, and callback is a function, then figure out if it a
        //CommonJS thing with dependencies.
        if (!deps.length && isFunction(callback)) {
            //Remove comments from the callback string,
            //look for require calls, and pull them into the dependencies,
            //but only if there are function args.
            if (callback.length) {
                callback
                    .toString()
                    .replace(commentRegExp, "")
                    .replace(cjsRequireRegExp, function (match, dep) {
                        deps.push(dep);
                    });

                //May be a CommonJS thing even without require calls, but still
                //could use exports, and module. Avoid doing exports and module
                //work though if it just needs require.
                //REQUIRES the function to expect the CommonJS variables in the
                //order listed below.
                deps = (callback.length === 1 ? ["require"] : ["require", "exports", "module"]).concat(deps);
            }
        }

        //If in IE 6-8 and hit an anonymous define() call, do the interactive
        //work.
        if (useInteractive) {
            node = currentlyAddingScript || getInteractiveScript();
            if (node) {
                if (!name) {
                    name = node.getAttribute("data-requiremodule");
                }
                context = contexts[node.getAttribute("data-requirecontext")];
            }
        }

        //Always save off evaluating the def call until the script onload handler.
        //This allows multiple modules to be in a file without prematurely
        //tracing dependencies, and allows for anonymous module support,
        //where the module name is not known until the script onload event
        //occurs. If no context, use the global queue, and get it processed
        //in the onscript load callback.
        (context ? context.defQueue : globalDefQueue).push([name, deps, callback]);

        return undefined;
    };

    define.amd = {
        multiversion: true,
        plugins: true,
        jQuery: true
    };

    /**
     * Executes the text. Normally just uses eval, but can be modified
     * to use a more environment specific call.
     * @param {String} text the text to execute/evaluate.
     */
    req.exec = function (text) {
        return eval(text);
    };

    /**
     * Executes a module callack function. Broken out as a separate function
     * solely to allow the build system to sequence the files in the built
     * layer in the right sequence.
     *
     * @private
     */
    req.execCb = function (name, callback, args, exports) {
        return callback.apply(exports, args);
    };


    /**
     * Adds a node to the DOM. Public function since used by the order plugin.
     * This method should not normally be called by outside code.
     */
    req.addScriptToDom = function (node) {
        //For some cache cases in IE 6-8, the script executes before the end
        //of the appendChild execution, so to tie an anonymous define
        //call to the module name (which is stored on the node), hold on
        //to a reference to this node, but clear after the DOM insertion.
        currentlyAddingScript = node;
        if (baseElement) {
            head.insertBefore(node, baseElement);
        } else {
            head.appendChild(node);
        }
        currentlyAddingScript = null;
    };

    /**
     * callback for script loads, used to check status of loading.
     *
     * @param {Event} evt the event from the browser for the script
     * that was loaded.
     *
     * @private
     */
    req.onScriptLoad = function (evt) {
        //Using currentTarget instead of target for Firefox 2.0's sake. Not
        //all old browsers will be supported, but this one was easy enough
        //to support and still makes sense.
        var node = evt.currentTarget || evt.srcElement, contextName, moduleName,
            context;

        if (evt.type === "load" || (node && readyRegExp.test(node.readyState))) {
            //Reset interactive script so a script node is not held onto for
            //to long.
            interactiveScript = null;

            //Pull out the name of the module and the context.
            contextName = node.getAttribute("data-requirecontext");
            moduleName = node.getAttribute("data-requiremodule");
            context = contexts[contextName];

            contexts[contextName].completeLoad(moduleName);

            //Clean up script binding. Favor detachEvent because of IE9
            //issue, see attachEvent/addEventListener comment elsewhere
            //in this file.
            if (node.detachEvent && !isOpera) {
                //Probably IE. If not it will throw an error, which will be
                //useful to know.
                node.detachEvent("onreadystatechange", req.onScriptLoad);
            } else {
                node.removeEventListener("load", req.onScriptLoad, false);
            }
        }
    };

    /**
     * Attaches the script represented by the URL to the current
     * environment. Right now only supports browser loading,
     * but can be redefined in other environments to do the right thing.
     * @param {String} url the url of the script to attach.
     * @param {Object} context the context that wants the script.
     * @param {moduleName} the name of the module that is associated with the script.
     * @param {Function} [callback] optional callback, defaults to require.onScriptLoad
     * @param {String} [type] optional type, defaults to text/javascript
     * @param {Function} [fetchOnlyFunction] optional function to indicate the script node
     * should be set up to fetch the script but do not attach it to the DOM
     * so that it can later be attached to execute it. This is a way for the
     * order plugin to support ordered loading in IE. Once the script is fetched,
     * but not executed, the fetchOnlyFunction will be called.
     */
    req.attach = function (url, context, moduleName, callback, type, fetchOnlyFunction) {
        var node;
        if (isBrowser) {
            //In the browser so use a script tag
            callback = callback || req.onScriptLoad;
            node = context && context.config && context.config.xhtml ?
                    document.createElementNS("http://www.w3.org/1999/xhtml", "html:script") :
                    document.createElement("script");
            node.type = type || (context && context.config.scriptType) ||
                        "text/javascript";
            node.charset = "utf-8";
            //Use async so Gecko does not block on executing the script if something
            //like a long-polling comet tag is being run first. Gecko likes
            //to evaluate scripts in DOM order, even for dynamic scripts.
            //It will fetch them async, but only evaluate the contents in DOM
            //order, so a long-polling script tag can delay execution of scripts
            //after it. But telling Gecko we expect async gets us the behavior
            //we want -- execute it whenever it is finished downloading. Only
            //Helps Firefox 3.6+
            //Allow some URLs to not be fetched async. Mostly helps the order!
            //plugin
            node.async = !s.skipAsync[url];

            if (context) {
                node.setAttribute("data-requirecontext", context.contextName);
            }
            node.setAttribute("data-requiremodule", moduleName);

            //Set up load listener. Test attachEvent first because IE9 has
            //a subtle issue in its addEventListener and script onload firings
            //that do not match the behavior of all other browsers with
            //addEventListener support, which fire the onload event for a
            //script right after the script execution. See:
            //https://connect.microsoft.com/IE/feedback/details/648057/script-onload-event-is-not-fired-immediately-after-script-execution
            //UNFORTUNATELY Opera implements attachEvent but does not follow the script
            //script execution mode.
            if (node.attachEvent && !isOpera) {
                //Probably IE. IE (at least 6-8) do not fire
                //script onload right after executing the script, so
                //we cannot tie the anonymous define call to a name.
                //However, IE reports the script as being in "interactive"
                //readyState at the time of the define call.
                useInteractive = true;


                if (fetchOnlyFunction) {
                    //Need to use old school onreadystate here since
                    //when the event fires and the node is not attached
                    //to the DOM, the evt.srcElement is null, so use
                    //a closure to remember the node.
                    node.onreadystatechange = function (evt) {
                        //Script loaded but not executed.
                        //Clear loaded handler, set the real one that
                        //waits for script execution.
                        if (node.readyState === 'loaded') {
                            node.onreadystatechange = null;
                            node.attachEvent("onreadystatechange", callback);
                            fetchOnlyFunction(node);
                        }
                    };
                } else {
                    node.attachEvent("onreadystatechange", callback);
                }
            } else {
                node.addEventListener("load", callback, false);
            }
            node.src = url;

            //Fetch only means waiting to attach to DOM after loaded.
            if (!fetchOnlyFunction) {
                req.addScriptToDom(node);
            }

            return node;
        } else if (isWebWorker) {
            //In a web worker, use importScripts. This is not a very
            //efficient use of importScripts, importScripts will block until
            //its script is downloaded and evaluated. However, if web workers
            //are in play, the expectation that a build has been done so that
            //only one script needs to be loaded anyway. This may need to be
            //reevaluated if other use cases become common.
            importScripts(url);

            //Account for anonymous modules
            context.completeLoad(moduleName);
        }
        return null;
    };

    //Look for a data-main script attribute, which could also adjust the baseUrl.
    if (isBrowser) {
        //Figure out baseUrl. Get it from the script tag with require.js in it.
        scripts = document.getElementsByTagName("script");

        for (globalI = scripts.length - 1; globalI > -1 && (script = scripts[globalI]); globalI--) {
            //Set the "head" where we can append children by
            //using the script's parent.
            if (!head) {
                head = script.parentNode;
            }

            //Look for a data-main attribute to set main script for the page
            //to load. If it is there, the path to data main becomes the
            //baseUrl, if it is not already set.
            if ((dataMain = script.getAttribute('data-main'))) {
                if (!cfg.baseUrl) {
                    //Pull off the directory of data-main for use as the
                    //baseUrl.
                    src = dataMain.split('/');
                    mainScript = src.pop();
                    subPath = src.length ? src.join('/')  + '/' : './';

                    //Set final config.
                    cfg.baseUrl = subPath;
                    //Strip off any trailing .js since dataMain is now
                    //like a module name.
                    dataMain = mainScript.replace(jsSuffixRegExp, '');
                }

                //Put the data-main script in the files to load.
                cfg.deps = cfg.deps ? cfg.deps.concat(dataMain) : [dataMain];

                break;
            }
        }
    }

    //See if there is nothing waiting across contexts, and if not, trigger
    //resourcesReady.
    req.checkReadyState = function () {
        var contexts = s.contexts, prop;
        for (prop in contexts) {
            if (!(prop in empty)) {
                if (contexts[prop].waitCount) {
                    return;
                }
            }
        }
        req.resourcesReady(true);
    };

    /**
     * Internal function that is triggered whenever all scripts/resources
     * have been loaded by the loader. Can be overridden by other, for
     * instance the domReady plugin, which wants to know when all resources
     * are loaded.
     */
    req.resourcesReady = function (isReady) {
        var contexts, context, prop;

        //First, set the public variable indicating that resources are loading.
        req.resourcesDone = isReady;

        if (req.resourcesDone) {
            //If jQuery with DOM ready delayed, release it now.
            contexts = s.contexts;
            for (prop in contexts) {
                if (!(prop in empty)) {
                    context = contexts[prop];
                    if (context.jQueryIncremented) {
                        jQueryHoldReady(context.jQuery, false);
                        context.jQueryIncremented = false;
                    }
                }
            }
        }
    };

    //FF < 3.6 readyState fix. Needed so that domReady plugin
    //works well in that environment, since require.js is normally
    //loaded via an HTML script tag so it will be there before window load,
    //where the domReady plugin is more likely to be loaded after window load.
    req.pageLoaded = function () {
        if (document.readyState !== "complete") {
            document.readyState = "complete";
        }
    };
    if (isBrowser) {
        if (document.addEventListener) {
            if (!document.readyState) {
                document.readyState = "loading";
                window.addEventListener("load", req.pageLoaded, false);
            }
        }
    }

    //Set up default context. If require was a configuration object, use that as base config.
    req(cfg);

    //If modules are built into require.js, then need to make sure dependencies are
    //traced. Use a setTimeout in the browser world, to allow all the modules to register
    //themselves. In a non-browser env, assume that modules are not built into require.js,
    //which seems odd to do on the server.
    if (req.isAsync && typeof setTimeout !== "undefined") {
        ctx = s.contexts[(cfg.context || defContextName)];
        //Indicate that the script that includes require() is still loading,
        //so that require()'d dependencies are not traced until the end of the
        //file is parsed (approximated via the setTimeout call).
        ctx.requireWait = true;
        setTimeout(function () {
            ctx.requireWait = false;

            if (!ctx.scriptCount) {
                ctx.resume();
            }
            req.checkReadyState();
        }, 0);
    }
}());

define("../tools/require", function(){});


//Small adapter for using r.js/build/jslib/node.js in this project.
var requirejsVars = {
    nodeRequire: require,
    require: requirejs,
    define: define
};

global.requirejsVars = requirejsVars;

//Used by some loader plugins that want to interact with built in node modules.
requirejs.nodeRequire = require;

//Set up the dynamic load config to use a directory that is the same name
//as the script that is running.
(function () {
    var path = require('path'),
        vpath = typeof voloPath === 'undefined' ? process.argv[1] : voloPath,
        name = path.basename(vpath, '.js'),
        baseUrl = path.join(path.dirname(vpath), name);

    requirejs.config({
        baseUrl: baseUrl
    });


    //Reflect the baseUrl as a module
    define('volo/baseUrl', [], function () {
        return baseUrl;
    });

}());

//Dummy module for q, just to prevent IO work. Will still throw an error,
//but it is caught inside q and handled in a good way.
define('event-queue', [], function () {
    return null;
});

define("../tools/requirejsVars", function(){});

/**
 * @license RequireJS node Copyright (c) 2010-2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/jrburke/requirejs for details
 */

/*jslint regexp: false, strict: false */
/*global require: false, define: false, requirejsVars: false, process: false */

/**
 * This adapter assumes that x.js has loaded it and set up
 * some variables. This adapter just allows limited RequireJS
 * usage from within the requirejs directory. The general
 * node adapater is r.js.
 */

(function () {
    var nodeReq = requirejsVars.nodeRequire,
        req = requirejsVars.require,
        def = requirejsVars.define,
        fs = nodeReq('fs'),
        path = nodeReq('path'),
        vm = nodeReq('vm');

    //Supply an implementation that allows synchronous get of a module.
    req.get = function (context, moduleName, relModuleMap) {
        if (moduleName === "require" || moduleName === "exports" || moduleName === "module") {
            req.onError(new Error("Explicit require of " + moduleName + " is not allowed."));
        }

        var ret,
            moduleMap = context.makeModuleMap(moduleName, relModuleMap);

        //Normalize module name, if it contains . or ..
        moduleName = moduleMap.fullName;

        if (moduleName in context.defined) {
            ret = context.defined[moduleName];
        } else {
            if (ret === undefined) {
                //Try to dynamically fetch it.
                req.load(context, moduleName, moduleMap.url);
                //The above call is sync, so can do the next thing safely.
                ret = context.defined[moduleName];
            }
        }

        return ret;
    };

    //Add wrapper around the code so that it gets the requirejs
    //API instead of the Node API, and it is done lexically so
    //that it survives later execution.
    req.makeNodeWrapper = function (contents) {
        return '(function (require, requirejs, define) { ' +
                contents +
                '\n}(requirejsVars.require, requirejsVars.requirejs, requirejsVars.define));';
    };

    req.load = function (context, moduleName, url) {
        var contents, err;

        //Indicate a the module is in process of loading.
        context.scriptCount += 1;

        if (path.existsSync(url)) {
            contents = fs.readFileSync(url, 'utf8');

            contents = req.makeNodeWrapper(contents);
            try {
                vm.runInThisContext(contents, fs.realpathSync(url));
            } catch (e) {
                err = new Error('Evaluating ' + url + ' as module "' +
                                moduleName + '" failed with error: ' + e);
                err.originalError = e;
                err.moduleName = moduleName;
                err.fileName = url;
                return req.onError(err);
            }
        } else {
            def(moduleName, function () {
                try {
                    return (context.config.nodeRequire || req.nodeRequire)(moduleName);
                } catch (e) {
                    err = new Error('Calling node\'s require("' +
                                        moduleName + '") failed with error: ' + e);
                    err.originalError = e;
                    err.moduleName = moduleName;
                    return req.onError(err);
                }
            });
        }

        //Support anonymous modules.
        context.completeLoad(moduleName);

        return undefined;
    };

    //Override to provide the function wrapper for define/require.
    req.exec = function (text) {
        /*jslint evil: true */
        text = req.makeNodeWrapper(text);
        return eval(text);
    };
}());
define("../tools/node", function(){});

/**
 * @license Copyright (c) 2010-2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/jrburke/requirejs for details
 */

/*jslint plusplus: false, strict: false */
/*global define: false */

define('volo/lang',[],function () {
    var lang = {
        backSlashRegExp: /\\/g,
        ostring: Object.prototype.toString,

        isArray: Array.isArray ? Array.isArray : function (it) {
            return lang.ostring.call(it) === "[object Array]";
        },

        /**
         * Simple function to mix in properties from source into target,
         * but only if target does not already have a property of the same name.
         */
        mixin: function (target, source, override) {
            //Use an empty object to avoid other bad JS code that modifies
            //Object.prototype.
            var empty = {}, prop;
            for (prop in source) {
                if (override || !(prop in target)) {
                    target[prop] = source[prop];
                }
            }
        },

        delegate: (function () {
            // boodman/crockford delegation w/ cornford optimization
            function TMP() {}
            return function (obj, props) {
                TMP.prototype = obj;
                var tmp = new TMP();
                TMP.prototype = null;
                if (props) {
                    lang.mixin(tmp, props);
                }
                return tmp; // Object
            };
        }())
    };
    return lang;
});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint */
/*global define, process, voloPath */

define('volo/config',['require','fs','path','./lang','./baseUrl'],function (require) {
    var fs = require('fs'),
        path = require('path'),
        lang = require('./lang'),
        //volo/baseUrl is set up in tools/requirejsVars.js
        baseUrl = require('./baseUrl'),
        localConfigUrl = path.join(baseUrl, '.config.js'),
        localConfig, config, contents;

    // The defaults to use.
    config = {
        "volo": {
            //Hold on to the name of the script
            "path": typeof voloPath === 'undefined' ? process.argv[1] : voloPath
        },

        "registry": "https://registry.npmjs.org/",

        "github": {
            "scheme": "https",
            "host": "github.com",
            "apiHost": "api.github.com",
            "rawUrlPattern": "https://raw.github.com/{owner}/{repo}/{version}/{file}",
            "overrides": {
                "jquery/jquery": {
                    "pattern": "http://code.jquery.com/jquery-{version}.js"
                }
            }
        },

        "volo/add": {
            "discard": {
                ".gitignore": true,
                "test": true,
                "tests": true,
                "doc": true,
                "docs": true,
                "example": true,
                "examples": true,
                "demo": true,
                "demos": true
            }
        }
    };

    //Allow a local config at baseUrl + '.config.js'
    if (path.existsSync(localConfigUrl)) {
        contents = (fs.readFileSync(localConfigUrl, 'utf8') || '').trim();

        if (contents) {
            localConfig = JSON.parse(contents);
            lang.mixin(config, localConfig, true);
        }
    }

    return config;
});

// vim:ts=4:sts=4:sw=4:
/*!
 *
 * Copyright 2007-2009 Tyler Close under the terms of the MIT X license found
 * at http://www.opensource.org/licenses/mit-license.html
 * Forked at ref_send.js version: 2009-05-11
 *
 * Copyright 2009-2011 Kris Kowal under the terms of the MIT
 * license found at http://github.com/kriskowal/q/raw/master/LICENSE
 *
 */

(function (definition, undefined) {

    // This file will function properly as a <script> tag, or a module
    // using CommonJS and NodeJS or RequireJS module formats.  In
    // Common/Node/RequireJS, the module exports the Q API and when
    // executed as a simple <script>, it creates a Q global instead.

    // The use of "undefined" in the arguments is a
    // micro-optmization for compression systems, permitting
    // every occurrence of the "undefined" variable to be
    // replaced with a single-character.

    // RequireJS
    if (typeof define === "function") {
        define('q',['require','exports','module'],function (require, exports, module) {
            definition(require, exports, module);
        });
    // CommonJS
    } else if (typeof exports === "object") {
        definition(require, exports, module);
    // <script>
    } else {
        Q = definition(undefined, {}, {});
    }

})(function (serverSideRequire, exports, module, undefined) {



var nextTick;
try {
    // Narwhal, Node (with a package, wraps process.nextTick)
    nextTick = serverSideRequire("event-queue").enqueue;
} catch (e) {
    // browsers
    if (typeof MessageChannel !== "undefined") {
        // modern browsers
        // http://www.nonblocking.io/2011/06/windownexttick.html
        var channel = new MessageChannel();
        // linked list of tasks (single, with head node)
        var head = {}, tail = head;
        channel.port1.onmessage = function () {
            var next = head.next;
            var task = next.task;
            head = next;
            task();
        };
        nextTick = function (task) {
            tail = tail.next = {task: task};
            channel.port2.postMessage();
        };
    } else {
        // old browsers
        nextTick = function (task) {
            setTimeout(task, 0);
        };
    }
}

// useful for an identity stub and default resolvers
function identity (x) {return x;}

// shims
var shim = function (object, name, shim) {
    if (!object[name])
        object[name] = shim;
    return object[name];
};

var freeze = shim(Object, "freeze", identity);

var create = shim(Object, "create", function (prototype) {
    var Type = function () {};
    Type.prototype = prototype;
    return new Type();
});

var keys = shim(Object, "keys", function (object) {
    var keys = [];
    for (var key in object)
        keys.push(key);
    return keys;
});

var reduce = Array.prototype.reduce || function (callback, basis) {
    var i = 0,
        ii = this.length;
    // concerning the initial value, if one is not provided
    if (arguments.length == 1) {
        // seek to the first value in the array, accounting
        // for the possibility that is is a sparse array
        do {
            if (i in this) {
                basis = this[i++];
                break;
            }
            if (++i >= ii)
                throw new TypeError();
        } while (1);
    }
    // reduce
    for (; i < ii; i++) {
        // account for the possibility that the array is sparse
        if (i in this) {
            basis = callback(basis, this[i], i);
        }
    }
    return basis;
};

var isStopIteration = function (exception) {
    return Object.prototype.toString.call(exception)
        === "[object StopIteration]";
};

// Abbreviations for performance and minification
var slice = Array.prototype.slice;
var nil = null;
var valueOf = function (value) {
    if (value === undefined || value === nil) {
        return value;
    } else {
        return value.valueOf();
    }
};

/**
 * Performs a task in a future turn of the event loop.
 * @param {Function} task
 */
exports.enqueue = // XXX enqueue deprecated
exports.nextTick = nextTick;

/**
 * Constructs a {promise, resolve} object.
 *
 * The resolver is a callback to invoke with a more resolved value for the
 * promise. To fulfill the promise, invoke the resolver with any value that is
 * not a function. To reject the promise, invoke the resolver with a rejection
 * object. To put the promise in the same state as another promise, invoke the
 * resolver with that other promise.
 */
exports.defer = defer;

function defer() {
    // if "pending" is an "Array", that indicates that the promise has not yet
    // been resolved.  If it is "undefined", it has been resolved.  Each
    // element of the pending array is itself an array of complete arguments to
    // forward to the resolved promise.  We coerce the resolution value to a
    // promise using the ref promise because it handles both fully
    // resolved values and other promises gracefully.
    var pending = [], value;

    var promise = create(Promise.prototype);

    promise.promiseSend = function () {
        var args = slice.call(arguments);
        if (pending) {
            pending.push(args);
        } else {
            nextTick(function () {
                value.promiseSend.apply(value, args);
            });
        }
    };

    promise.valueOf = function () {
        if (pending)
            return promise;
        return value.valueOf();
    };

    var resolve = function (resolvedValue) {
        var i, ii, task;
        if (!pending)
            return;
        value = ref(resolvedValue);
        reduce.call(pending, function (undefined, pending) {
            nextTick(function () {
                value.promiseSend.apply(value, pending);
            });
        }, undefined);
        pending = undefined;
        return value;
    };

    return {
        "promise": freeze(promise),
        "resolve": resolve,
        "reject": function (reason) {
            return resolve(reject(reason));
        }
    };
}

/**
 * Constructs a Promise with a promise descriptor object and optional fallback
 * function.  The descriptor contains methods like when(rejected), get(name),
 * put(name, value), post(name, args), and delete(name), which all
 * return either a value, a promise for a value, or a rejection.  The fallback
 * accepts the operation name, a resolver, and any further arguments that would
 * have been forwarded to the appropriate method above had a method been
 * provided with the proper name.  The API makes no guarantees about the nature
 * of the returned object, apart from that it is usable whereever promises are
 * bought and sold.
 */
exports.makePromise = Promise;
function Promise(descriptor, fallback, valueOf) {

    if (fallback === undefined) {
        fallback = function (op) {
            return reject("Promise does not support operation: " + op);
        };
    }

    var promise = create(Promise.prototype);

    promise.promiseSend = function (op, resolved /* ...args */) {
        var args = slice.call(arguments, 2);
        var result;
        try {
            if (descriptor[op]) {
                result = descriptor[op].apply(descriptor, args);
            } else {
                result = fallback.apply(descriptor, [op].concat(args));
            }
        } catch (exception) {
            result = reject(exception);
        }
        return (resolved || identity)(result);
    };

    if (valueOf)
        promise.valueOf = valueOf;

    return freeze(promise);
};

// provide thenables, CommonJS/Promises/A
Promise.prototype.then = function (fulfilled, rejected) {
    return when(this, fulfilled, rejected);
};

// Chainable methods
reduce.call(
    [
        "when", "send",
        "get", "put", "del",
        "post", "invoke",
        "keys",
        "apply", "call",
        "all", "wait", "join",
        "fail", "fin", "spy", // XXX spy deprecated
        "view", "viewInfo",
        "timeout", "delay",
        "end"
    ],
    function (prev, name) {
        Promise.prototype[name] = function () {
            return exports[name].apply(
                exports,
                [this].concat(slice.call(arguments))
            );
        };
    },
    undefined
)

Promise.prototype.toSource = function () {
    return this.toString();
};

Promise.prototype.toString = function () {
    return '[object Promise]';
};

freeze(Promise.prototype);

/**
 * @returns whether the given object is a promise.
 * Otherwise it is a fulfilled value.
 */
exports.isPromise = isPromise;
function isPromise(object) {
    return object && typeof object.promiseSend === "function";
};

/**
 * @returns whether the given object is a resolved promise.
 */
exports.isResolved = isResolved;
function isResolved(object) {
    return !isPromise(valueOf(object));
};

/**
 * @returns whether the given object is a value or fulfilled
 * promise.
 */
exports.isFulfilled = isFulfilled;
function isFulfilled(object) {
    return !isPromise(valueOf(object)) && !isRejected(object);
};

/**
 * @returns whether the given object is a rejected promise.
 */
exports.isRejected = isRejected;
function isRejected(object) {
    object = valueOf(object);
    if (object === undefined || object === nil)
        return false;
    return !!object.promiseRejected;
}

/**
 * Constructs a rejected promise.
 * @param reason value describing the failure
 */
exports.reject = reject;
function reject(reason) {
    return Promise({
        "when": function (rejected) {
            return rejected ? rejected(reason) : reject(reason);
        }
    }, function fallback(op) {
        return reject(reason);
    }, function valueOf() {
        var rejection = create(reject.prototype);
        rejection.promiseRejected = true;
        rejection.reason = reason;
        return rejection;
    });
}

reject.prototype = create(Promise.prototype, {
    constructor: { value: reject }
});

/**
 * Constructs a promise for an immediate reference.
 * @param value immediate reference
 */
exports.ref = ref;
function ref(object) {
    // If the object is already a Promise, return it directly.  This enables
    // the ref function to both be used to created references from
    // objects, but to tolerably coerce non-promises to refs if they are
    // not already Promises.
    if (isPromise(object))
        return object;
    // assimilate thenables, CommonJS/Promises/A
    if (object && typeof object.then === "function") {
        var result = defer();
        object.then(result.resolve, result.reject);
        return result.promise;
    }
    return Promise({
        "when": function (rejected) {
            return object;
        },
        "get": function (name) {
            return object[name];
        },
        "put": function (name, value) {
            return object[name] = value;
        },
        "del": function (name) {
            return delete object[name];
        },
        "post": function (name, value) {
            return object[name].apply(object, value);
        },
        "apply": function (self, args) {
            return object.apply(self, args);
        },
        "viewInfo": function () {
            var on = object;
            var properties = {};
            while (on) {
                Object.getOwnPropertyNames(on).forEach(function (name) {
                    if (!properties[name])
                        properties[name] = typeof on[name];
                });
                on = Object.getPrototypeOf(on);
            }
            return {
                "type": typeof object,
                "properties": properties
            }
        },
        "keys": function () {
            return keys(object);
        }
    }, undefined, function valueOf() {
        return object;
    });
}

/**
 * Annotates an object such that it will never be
 * transferred away from this process over any promise
 * communication channel.
 * @param object
 * @returns promise a wrapping of that object that
 * additionally responds to the 'isDef' message
 * without a rejection.
 */
exports.master =
exports.def = def;
function def(object) {
    return Promise({
        "isDef": function () {}
    }, function fallback(op) {
        var args = slice.call(arguments);
        return send.apply(undefined, [object].concat(args));
    }, function () {
        return valueOf(object);
    });
}

exports.viewInfo = viewInfo;
function viewInfo(object, info) {
    object = ref(object);
    if (info) {
        return Promise({
            "viewInfo": function () {
                return info;
            }
        }, function fallback(op) {
            var args = slice.call(arguments);
            return send.apply(undefined, [object].concat(args));
        }, function () {
            return valueOf(object);
        });
    } else {
        return send(object, "viewInfo")
    }
}

exports.view = function (object) {
    return viewInfo(object).when(function (info) {
        var view;
        if (info.type === "function") {
            view = function () {
                return apply(object, undefined, arguments);
            };
        } else {
            view = {};
        }
        var properties = info.properties || {};
        Object.keys(properties).forEach(function (name) {
            if (properties[name] === "function") {
                view[name] = function () {
                    return post(object, name, arguments);
                };
            }
        });
        return ref(view);
    });
};

/**
 * Registers an observer on a promise.
 *
 * Guarantees:
 *
 * 1. that fulfilled and rejected will be called only once.
 * 2. that either the fulfilled callback or the rejected callback will be
 *    called, but not both.
 * 3. that fulfilled and rejected will not be called in this turn.
 *
 * @param value     promise or immediate reference to observe
 * @param fulfilled function to be called with the fulfilled value
 * @param rejected  function to be called with the rejection reason
 * @return promise for the return value from the invoked callback
 */
exports.when = when;
function when(value, fulfilled, rejected) {
    var deferred = defer();
    var done = false;   // ensure the untrusted promise makes at most a
                        // single call to one of the callbacks

    function _fulfilled(value) {
        try {
            return fulfilled ? fulfilled(value) : value;
        } catch (exception) {
            return reject(exception);
        }
    }

    function _rejected(reason) {
        try {
            return rejected ? rejected(reason) : reject(reason);
        } catch (exception) {
            return reject(exception);
        }
    }

    nextTick(function () {
        ref(value).promiseSend("when", function (value) {
            if (done)
                return;
            done = true;
            deferred.resolve(
                ref(value)
                .promiseSend("when", _fulfilled, _rejected)
            );
        }, function (reason) {
            if (done)
                return;
            done = true;
            deferred.resolve(_rejected(reason));
        });
    });

    return deferred.promise;
}

/**
 * The async function is a decorator for generator functions, turning
 * them into asynchronous generators.  This presently only works in
 * Firefox/Spidermonkey, however, this code does not cause syntax
 * errors in older engines.  This code should continue to work and
 * will in fact improve over time as the language improves.
 *
 * Decorates a generator function such that:
 *  - it may yield promises
 *  - execution will continue when that promise is fulfilled
 *  - the value of the yield expression will be the fulfilled value
 *  - it returns a promise for the return value (when the generator
 *    stops iterating)
 *  - the decorated function returns a promise for the return value
 *    of the generator or the first rejected promise among those
 *    yielded.
 *  - if an error is thrown in the generator, it propagates through
 *    every following yield until it is caught, or until it escapes
 *    the generator function altogether, and is translated into a
 *    rejection for the promise returned by the decorated generator.
 *  - in present implementations of generators, when a generator
 *    function is complete, it throws ``StopIteration``, ``return`` is
 *    a syntax error in the presence of ``yield``, so there is no
 *    observable return value. There is a proposal[1] to add support
 *    for ``return``, which would permit the value to be carried by a
 *    ``StopIteration`` instance, in which case it would fulfill the
 *    promise returned by the asynchronous generator.  This can be
 *    emulated today by throwing StopIteration explicitly with a value
 *    property.
 *
 *  [1]: http://wiki.ecmascript.org/doku.php?id=strawman:async_functions#reference_implementation
 *
 */
exports.async = async;
function async(makeGenerator) {
    return function () {
        // when verb is "send", arg is a value
        // when verb is "throw", arg is a reason/error
        var continuer = function (verb, arg) {
            var result;
            try {
                result = generator[verb](arg);
            } catch (exception) {
                if (isStopIteration(exception)) {
                    return exception.value;
                } else {
                    return reject(exception);
                }
            }
            return when(result, callback, errback);
        };
        var generator = makeGenerator.apply(this, arguments);
        var callback = continuer.bind(continuer, "send");
        var errback = continuer.bind(continuer, "throw");
        return callback();
    };
}

/**
 * Constructs a promise method that can be used to safely observe resolution of
 * a promise for an arbitrarily named method like "propfind" in a future turn.
 *
 * "Method" constructs methods like "get(promise, name)" and "put(promise)".
 */
exports.Method = Method;
function Method (op) {
    return function (object) {
        var args = slice.call(arguments, 1);
        return send.apply(undefined, [object, op].concat(args));
    };
}

/**
 * sends a message to a value in a future turn
 * @param object* the recipient
 * @param op the name of the message operation, e.g., "when",
 * @param ...args further arguments to be forwarded to the operation
 * @returns result {Promise} a promise for the result of the operation
 */
exports.send = send;
function send(object, op) {
    var deferred = defer();
    var args = slice.call(arguments, 2);
    object = ref(object);
    nextTick(function () {
        object.promiseSend.apply(
            object,
            [op, deferred.resolve].concat(args)
        );
    });
    return deferred.promise;
}

/**
 * Gets the value of a property in a future turn.
 * @param object    promise or immediate reference for target object
 * @param name      name of property to get
 * @return promise for the property value
 */
exports.get = Method("get");

/**
 * Sets the value of a property in a future turn.
 * @param object    promise or immediate reference for object object
 * @param name      name of property to set
 * @param value     new value of property
 * @return promise for the return value
 */
exports.put = Method("put");

/**
 * Deletes a property in a future turn.
 * @param object    promise or immediate reference for target object
 * @param name      name of property to delete
 * @return promise for the return value
 */
exports.del = Method("del");

/**
 * Invokes a method in a future turn.
 * @param object    promise or immediate reference for target object
 * @param name      name of method to invoke
 * @param value     a value to post, typically an array of
 *                  invocation arguments for promises that
 *                  are ultimately backed with `ref` values,
 *                  as opposed to those backed with URLs
 *                  wherein the posted value can be any
 *                  JSON serializable object.
 * @return promise for the return value
 */
var post = exports.post = Method("post");

/**
 * Invokes a method in a future turn.
 * @param object    promise or immediate reference for target object
 * @param name      name of method to invoke
 * @param ...args   array of invocation arguments
 * @return promise for the return value
 */
exports.invoke = function (value, name) {
    var args = slice.call(arguments, 2);
    return post(value, name, args);
};

/**
 * Applies the promised function in a future turn.
 * @param object    promise or immediate reference for target function
 * @param context   the context object (this) for the call
 * @param args      array of application arguments
 */
var apply = exports.apply = Method("apply");

/**
 * Calls the promised function in a future turn.
 * @param object    promise or immediate reference for target function
 * @param context   the context object (this) for the call
 * @param ...args   array of application arguments
 */
exports.call = function (value, context) {
    var args = slice.call(arguments, 2);
    return apply(value, context, args);
};

/**
 * Requests the names of the owned properties of a promised
 * object in a future turn.
 * @param object    promise or immediate reference for target object
 * @return promise for the keys of the eventually resolved object
 */
exports.keys = Method("keys");

// By Mark Miller
// http://wiki.ecmascript.org/doku.php?id=strawman:concurrency&rev=1308776521#allfulfilled
exports.all = all;
function all(promises) {
    return when(promises, function (promises) {
        var countDown = promises.length;
        var values = [];
        if (countDown === 0)
            return ref(values);
        var deferred = defer();
        reduce.call(promises, function (undefined, promise, index) {
            when(promise, function (answer) {
                values[index] = answer;
                if (--countDown === 0)
                    deferred.resolve(values);
            }, deferred.reject);
        }, undefined);
        return deferred.promise;
    });
}

/**
 */
exports.wait = function (promise) {
    return all(arguments).get(0);
};

/**
 */
exports.join = function () {
    var args = slice.call(arguments);
    var callback = args.pop();
    return all(args).then(function (args) {
        return callback.apply(undefined, args);
    });
};

/**
 */
exports.fail = fail;
function fail(promise, rejected) {
    return when(promise, undefined, rejected);
}

/**
 */
exports.spy = // XXX spy deprecated
exports.fin = fin;
function fin(promise, callback) {
    return when(promise, function (value) {
        return when(callback(), function () {
            return value;
        });
    }, function (reason) {
        return when(callback(), function () {
            return reject(reason);
        });
    });
}

/**
 * Terminates a chain of promises, forcing rejections to be
 * thrown as exceptions.
 */
exports.end = end;
function end(promise) {
    when(promise, undefined, function (error) {
        // forward to a future turn so that ``when``
        // does not catch it and turn it into a rejection.
        nextTick(function () {
            throw error;
        });
    });
}

/**
 */
exports.timeout = timeout;
function timeout(promise, timeout) {
    var deferred = defer();
    when(promise, deferred.resolve, deferred.reject);
    setTimeout(function () {
        deferred.reject("Timed out");
    }, timeout);
    return deferred.promise;
}

/**
 */
exports.delay = delay;
function delay(promise, timeout) {
    var deferred = defer();
    setTimeout(function () {
        deferred.resolve(promise);
    }, timeout);
    return deferred.promise;
}

/*
 * In module systems that support ``module.exports`` assignment or exports
 * return, allow the ``ref`` function to be used as the ``Q`` constructor
 * exported by the "q" module.
 */
for (var name in exports)
    ref[name] = exports[name];
module.exports = ref;
return ref;

});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint */
/*global define */

define('volo/qutil',['require','q'],function (require) {
    var q = require('q');

    return {
        convert: function (callback, errback) {
            var d = q.defer();
            q.when(d.promise, callback, errback);
            return d;
        },

        add: function (array, promise) {
            var prevPromise = array[array.length - 1];
            if (prevPromise) {

                deferred.resolve(prevPromise);
            }
            array.push(deferred.promise);

            return array;
        }
    }

    return callDefer;
});


/*jslint plusplus: false */
/*global define */

define('volo/file',['require','fs','path','child_process','./qutil'],function (require) {
    var fs = require('fs'),
        path = require('path'),
        exec = require('child_process').exec,
        qutil = require('./qutil'),
        file;

    function frontSlash(path) {
        return path.replace(/\\/g, '/');
    }

    function findMatches(matches, dir, regExpInclude, regExpExclude, dirRegExpExclude) {
        if (path.existsSync(dir) && fs.statSync(dir).isDirectory()) {
            var files = fs.readdirSync(dir);
            files.forEach(function (filePath) {
                filePath = path.join(dir, filePath);
                var stat = fs.statSync(filePath),
                    ok = false;
                if (stat.isFile()) {
                    ok = true;
                    if (regExpInclude) {
                        ok = filePath.match(regExpInclude);
                    }
                    if (ok && regExpExclude) {
                        ok = !filePath.match(regExpExclude);
                    }

                    if (ok) {
                        matches.push(filePath);
                    }
                } else if (stat.isDirectory() && !dirRegExpExclude.test(filePath)) {
                    findMatches(matches, filePath, regExpInclude, regExpExclude, dirRegExpExclude);
                }
            });
        }
    }

    file = {
        /**
         * Recurses startDir and finds matches to the files that match
         * regExpFilters.include and do not match regExpFilters.exclude.
         * Or just one regexp can be passed in for regExpFilters,
         * and it will be treated as the "include" case.
         *
         * @param {String} startDir the directory to start the search
         * @param {RegExp} regExpInclude regexp to match files to include
         * @param {RegExp} [regExpExclude] regexp to exclude files.
         * @param {RegExp} [dirRegExpExclude] regexp to exclude directories. By default
         * ignores .git, .hg, .svn and CVS directories.
         *
         * @returns {Array} List of file paths. Could be zero length if no matches.
         */
        getFilteredFileList: function (startDir, regExpInclude, regExpExclude, dirRegExpExclude) {
            var files = [];

            //By default avoid source control directories
            if (!dirRegExpExclude) {
                dirRegExpExclude = /\.git|\.hg|\.svn|CVS/;
            }

            findMatches(files, startDir, regExpInclude, regExpExclude, dirRegExpExclude);

            return files;
        },

        /**
         * Reads a file, synchronously.
         * @param {String} path the path to the file.
         */
        readFile: function (path) {
            return fs.readFileSync(path, 'utf8');
        },

        /**
         * Recursively creates directories in dir string.
         * @param {String} dir the directory to create.
         */
        mkdirs: function (dir) {
            var parts = dir.split('/'),
                currDir = '',
                first = true;

            parts.forEach(function (part) {
                //First part may be empty string if path starts with a slash.
                currDir += part + '/';
                first = false;

                if (part) {
                    if (!path.existsSync(currDir)) {
                        fs.mkdirSync(currDir, 511);
                    }
                }
            });
        },

        /**
         * Does an rm -rf on a directory. Like a boss.
         */
        rmdir: function (dir, callback, errback) {
            var d = qutil.convert(callback, errback);

            if (!dir) {
                d.resolve();
            }

            dir = path.resolve(dir);

            if (!path.existsSync(dir)) {
                d.resolve();
            }

            if (dir === '/') {
                d.reject(new Error('file.rmdir cannot handle /'));
            }

            exec('rm -rf ' + dir,
                function (error, stdout, stderr) {
                    if (error) {
                        d.reject(error);
                    } else {
                        d.resolve();
                    }
                }
            );

            return d.promise;
        },

        /**
         * Returns the first directory found inside a directory.
         * The return results is dir + firstDir name.
         */
        firstDir: function (dir) {
            var firstDir = null;

            fs.readdirSync(dir).some(function (file) {
                firstDir = path.join(dir, file);
                if (fs.statSync(firstDir).isDirectory()) {
                    return true;
                } else {
                    firstDir = null;
                    return false;
                }
            });

            return firstDir;
        },

        copyDir: function (/*String*/srcDir, /*String*/destDir, /*RegExp?*/regExpFilter, /*boolean?*/onlyCopyNew) {
            //summary: copies files from srcDir to destDir using the regExpFilter to determine if the
            //file should be copied. Returns a list file name strings of the destinations that were copied.
            regExpFilter = regExpFilter || /\w/;

            //Normalize th directory names, but keep front slashes.
            //path module on windows now returns backslashed paths.
            srcDir = frontSlash(path.normalize(srcDir));
            destDir = frontSlash(path.normalize(destDir));

            var fileNames = file.getFilteredFileList(srcDir, regExpFilter, true),
            copiedFiles = [], i, srcFileName, destFileName;

            for (i = 0; i < fileNames.length; i++) {
                srcFileName = fileNames[i];
                destFileName = srcFileName.replace(srcDir, destDir);

                if (file.copyFile(srcFileName, destFileName, onlyCopyNew)) {
                    copiedFiles.push(destFileName);
                }
            }

            return copiedFiles.length ? copiedFiles : null; //Array or null
        },


        copyFile: function (/*String*/srcFileName, /*String*/destFileName, /*boolean?*/onlyCopyNew) {
            //summary: copies srcFileName to destFileName. If onlyCopyNew is set, it only copies the file if
            //srcFileName is newer than destFileName. Returns a boolean indicating if the copy occurred.
            var parentDir;

            //logger.trace("Src filename: " + srcFileName);
            //logger.trace("Dest filename: " + destFileName);

            //If onlyCopyNew is true, then compare dates and only copy if the src is newer
            //than dest.
            if (onlyCopyNew) {
                if (path.existsSync(destFileName) && fs.statSync(destFileName).mtime.getTime() >= fs.statSync(srcFileName).mtime.getTime()) {
                    return false; //Boolean
                }
            }

            //Make sure destination dir exists.
            parentDir = path.dirname(destFileName);
            if (!path.existsSync(parentDir)) {
                file.mkdirs(parentDir);
            }

            fs.writeFileSync(destFileName, fs.readFileSync(srcFileName, 'binary'), 'binary');

            return true; //Boolean
        }
    };

    return file;
});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint plusplus: false */
/*global define, console */

define('volo/version',['require'],function (require) {
    var hasSuffixRegExp = /\d+([\w]+)(\d+)?$/,
        vPrefixRegExp = /^v/;

    return {
        /**
         * A Compare function that can be used in an array sort call.
         * a and b should be N.N.N or vN.N.N version strings. If a is a greater
         * version number than b, then the function returns -1 to indicate
         * it should be sorted before b. In other words, the sorted
         * values will be from highest version to lowest version when
         * using this function for sorting.
         *
         * If the string starts with a "v" it will be stripped before the
         * comparison.
         */
        compare: function (a, b) {
            var aParts = a.split('.'),
                bParts = b.split('.'),
                length = Math.max(aParts.length, bParts.length),
                i, aPart, bPart, aHasSuffix, bHasSuffix;

            //Remove any "v" prefixes
            aParts[0] = aParts[0].replace(vPrefixRegExp, '');
            bParts[0] = bParts[0].replace(vPrefixRegExp, '');

            for (i = 0; i < length; i++) {
                aPart = parseInt(aParts[i] || '0', 10);
                bPart = parseInt(bParts[i] || '0', 10);

                if (aPart > bPart) {
                    return -1;
                } else if (aPart < bPart) {
                    return 1;
                } else {
                    //parseInt values are equal. Favor string
                    //values that do not have character suffixes.
                    //So, 1.0.0 should be sorted higher than 1.0.0.pre
                    aHasSuffix = hasSuffixRegExp.exec(aParts[i]);
                    bHasSuffix = hasSuffixRegExp.exec(bParts[i]);
                    if (!aHasSuffix && !bHasSuffix) {
                        continue;
                    } else if (!aHasSuffix && bHasSuffix) {
                        return -1;
                    } else if (aHasSuffix && !bHasSuffix) {
                        return 1;
                    } else {
                        //If the character parts of the suffix differ,
                        //do a lexigraphic compare.
                        if (aHasSuffix[1] > bHasSuffix[1]) {
                            return -1;
                        } else if (aHasSuffix[1] < bHasSuffix[1]) {
                            return 1;
                        } else {
                            //character parts match, so compare the trailing
                            //digits.
                            aPart = parseInt(aHasSuffix[2] || '0', 10);
                            bPart = parseInt(bHasSuffix[2] || '0', 10);
                            if (aPart > bPart) {
                                return -1;
                            } else {
                                return 1;
                            }
                        }
                    }
                }
            }

            return 0;
        }
    };
});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint regexp: false */
/*global define, console */

define('volo/github',['require','q','https','volo/config','volo/version'],function (require) {
    var q = require('q'),
        https = require('https'),
        config = require('volo/config').github,
        scheme = config.scheme,
        version = require('volo/version'),
        host = config.host,
        apiHost = config.apiHost,
        versionRegExp = /^(v)?(\d+\..+)/;

    function github(path) {
        var args = {
            host: apiHost,
            path: '/' + path
        },
        d = q.defer();

        https.get(args, function (response) {
            //console.log("statusCode: ", response.statusCode);
            //console.log("headers: ", response.headers);
            var body = '';

            response.on('data', function (data) {
                body += data;
            });

            response.on('end', function () {
                if (response.statusCode === 404) {
                    d.reject(args.host + args.path + ' does not exist');
                } else if (response.statusCode === 200) {
                    //Convert the response into an object
                    d.resolve(JSON.parse(body));
                } else {
                    d.reject(args.host + args.path + ' returned status: ' +
                             response.statusCode + '. ' + body);
                }
            });
        }).on('error', function (e) {
            d.reject(e);
        });

        return d.promise;
    }

    github.url = function (path) {
        return scheme + '://' + host + '/' + path;
    };

    github.apiUrl = function (path) {
        return scheme + '://' + apiHost + '/' + path;
    };

    github.rawUrl = function (ownerPlusRepo, version, specificFile) {
        var parts = ownerPlusRepo.split('/'),
            owner = parts[0],
            repo = parts[1];

        return config.rawUrlPattern
                     .replace(/\{owner\}/g, owner)
                     .replace(/\{repo\}/g, repo)
                     .replace(/\{version\}/g, version)
                     .replace(/\{file\}/g, specificFile);
    };

    github.tarballUrl = function (ownerPlusRepo, version) {
        return github.url(ownerPlusRepo) + '/tarball/' + version;
    };

    github.tags = function (ownerPlusRepo) {
        return github('repos/' + ownerPlusRepo + '/tags').then(function (data) {
            data = data.map(function (data) {
                return data.name;
            });

            return data;
        });
    };


    github.versionTags = function (ownerPlusRepo) {
        return github.tags(ownerPlusRepo).then(function (tagNames) {
            //Only collect tags that are version tags.
            tagNames = tagNames.filter(function (tag) {
                return versionRegExp.test(tag);
            });

            //Now order the tags in tag order.
            tagNames.sort(version.compare);

            //Default to master if no version tags available.
            if (!tagNames.length) {
                tagNames = ['master'];
            }

            return tagNames;
        });
    };

    github.latestTag = function (ownerPlusRepo) {
        //If ownerPlusRepo includes the version, just use that.
        var parts = ownerPlusRepo.split('/'),
            d;
        if (parts.length === 3) {
            d = q.defer();
            d.resolve(parts[2]);
            return d.promise;
        } else {
            return github.versionTags(ownerPlusRepo).then(function (tagNames) {
                return tagNames[0];
            });
        }
    };

    return github;
});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint */
/*global define, console */

define('volo/archive',['require','q','path'],function (require) {
    var q = require('q'),
        path = require('path'),
        endSlashIndexRegExp = /[\/\\]$/,
        tarGzRegExp = /\.tar\.gz$/,
        //Regexp used to strip off file extension
        fileExtRegExp = /\.tar\.gz$|\.\w+$/,
        handledSchemes = {
            http: true,
            https: true,
            local: true,
            symlink: true
        };

    return {
        /**
         * Resolves an archive value to a .tar.gz http/https URL.
         * Depends on specific resolver modules to do the work.
         * If no scheme is on the value, the default is assumed
         * to be a github resource.
         * @param {String} archive a string that can somehow resolved to
         * an http/https URL to a .tar.gz or individual file.
         *
         * @param {Function} [resolve] an optional resolve function to use
         * to resolve relative local file paths.
         *
         * Returns a promise with the properly resolved value being an
         * object with the following properties:
         *
         * * url: the http/https URL to fetch the archive or single file
         * * isArchive: true if the URL points to a .tar.gz file.
         * * fragment: if a fragment ID (# part) was specified on the original
         *             archive value, normally meaning a file withint an archive
         * * localName: a possible local name to use for the extracted archive
         *              value. Useful to use when an explicit one is not
         *              specified by the user.
         */
        resolve: function (archive, resolve) {

            var d = q.defer(),
                index = archive.indexOf(':'),
                fragIndex = archive.indexOf('#'),
                fragment = null,
                localRefName, scheme,  resolverId, localName;

            //If there is a specific file desired inside the archive, peel
            //that off.
            if (fragIndex !== -1) {
                fragment = archive.substring(fragIndex + 1);
                archive = archive.substring(0, fragIndex);
            }

            //Make sure the archive does not end in a slash, since slashes
            //are important, particularly for github urls.
            archive = archive.replace(endSlashIndexRegExp, '');

            //Figure out the scheme. Default is github, unless a local
            //path matches.
            if (index === -1) {
                if (archive.indexOf('.') === 0 || path.existsSync(archive)) {
                    scheme = 'local';
                } else {
                    scheme = 'github';
                }
            } else {
                scheme = archive.substring(0, index);
                archive = archive.substring(index + 1);
            }

            if (handledSchemes.hasOwnProperty(scheme)) {
                //localName is the file name without extension. If a .tar.gz
                //file, then a does not include .tar.gz
                if (fragment) {
                    localRefName = fragment;
                } else {
                    localRefName = archive;
                }
                localName = localRefName.substring(localRefName.lastIndexOf('/') + 1);
                localName = localName.replace(fileExtRegExp, '');

                //Resolve relative paths for this particular archive
                //resolve call.
                if ((scheme === 'symlink' || scheme === 'local') && resolve) {
                    archive = resolve(archive);

                    //If the archive source does not exist, bail.
                    if (!path.existsSync(archive)) {
                        d.reject(new Error(archive + ' does not exist'));
                        return d.promise;
                    }
                }

                d.resolve({
                    scheme: scheme,
                    url: scheme + ':' + archive,
                    isArchive: tarGzRegExp.test(archive),
                    fragment: fragment,
                    localName: localName
                });
            } else {
                //Figure out if there is a resolver for the given scheme.
                resolverId = 'volo/resolve/' + scheme;

                if (require.defined(resolverId) ||
                    path.existsSync(require.toUrl(resolverId + '.js'))) {
                    require([resolverId], function (resolve) {
                        resolve(archive, fragment, d.resolve, d.reject);
                    });
                } else {
                    d.reject('Do not have a volo resolver for scheme: ' + scheme);
                }
            }

            return d.promise;
        },

        /**
         * Just tests if the given URL ends in .tar.gz
         */
        isArchive: function (url) {
            return tarGzRegExp.test(url);
        }
    };
});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint */
/*global define, console */

define('volo/resolve/github',['require','path','../config','../archive','../github'],function (require) {
    var path = require('path'),
        config = require('../config'),
        archive = require('../archive'),
        github = require('../github');

    function resolveGithub(archiveName, fragment, callback, errback) {

        var parts = archiveName.split('/'),
            ownerPlusRepo, version, localName, override;

        localName = parts[1];

        ownerPlusRepo = parts[0] + '/'  + parts[1];
        version = parts[2];

        override = config.github.overrides[ownerPlusRepo];

        //Fetch the latest version
        github.latestTag(ownerPlusRepo + (version ? '/' + version : ''))
            .then(function (tag) {
                var isArchive = true,
                    url;

                //If there is a specific override to finding the file,
                //for instance jQuery releases are put on a CDN and are not
                //committed to github, use the override.
                if (fragment || (override && override.pattern)) {
                    //If a specific file in the repo. Do not need the full
                    //tarball, just use a raw github url to get it.
                    if (fragment) {
                        url = github.rawUrl(ownerPlusRepo, tag, fragment);
                        //Adjust local name to be the fragment name.
                        localName = path.basename(fragment);
                        //Strip off extension name.
                        localName = localName.substring(0, localName.lastIndexOf('.'));
                    } else {
                        //An override situation.
                        url = override.pattern.replace(/\{version\}/, tag);
                    }

                    //Set fragment to null since it has already been processed.
                    fragment = null;

                    isArchive = archive.isArchive(url);
                } else {
                    url = github.tarballUrl(ownerPlusRepo, tag);
                }

                return {
                    scheme: 'github',
                    url: url,
                    isArchive: isArchive,
                    fragment: fragment,
                    localName: localName
                };
            })
            .then(callback, errback);
    }

    return resolveGithub;
});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint */
/*global define */

/**
 * Reads a volofile from a target directory, and exports the data as a
 * set of modules.
 */
define('volo/template',['require'],function (require) {
    var tokenRegExp = /\{(\w+)\}/g;

    function template(contents, data) {
        return contents.replace(tokenRegExp, function (match, token) {
            var result = data[token];

            //Just use empty string for null or undefined
            if (result === null || result === undefined) {
                result = '';
            }

            return result;
        });
    }

    return template;
});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint plusplus: false */
/*global define, console, process */

define('volo/v',['require','path','fs','q','child_process','volo/file','volo/template','volo/qutil'],function (require) {
    var path = require('path'),
        fs = require('fs'),
        q = require('q'),
        exec = require('child_process').exec,
        file = require('volo/file'),
        template = require('volo/template'),
        qutil = require('volo/qutil'),
        defaultEncoding = 'utf8';

    /**
    * Creates a v instance that is bound to the dirName path, all paths are
    * resolved relative to that path.
    */
    function v(dirName) {

        function resolve(relativePath) {
            return path.resolve(dirName, relativePath);
        }

        var instance = {
            env: {
                path: path.resolve(dirName),
                exists: function (filePath) {
                    return path.existsSync(filePath);
                },
                read: function (filePath, encoding) {
                    return fs.readFileSync(resolve(filePath),
                                          (encoding || defaultEncoding));
                },
                template: function (text, data) {
                    return template(text, data);
                },
                write: function (filePath, contents, encoding) {
                    return fs.writeFileSync(filePath, contents,
                                            (encoding || defaultEncoding));
                },
                rm: function (dirOrFile) {
                    dirOrFile = resolve(dirOrFile);
                    var stat = fs.statSync(dirOrFile);
                    if (stat.isFile()) {
                        fs.unlinkSync(dirOrFile);
                    } else if (stat.isDirectory()) {
                        //TODO: need to make rmdir synchronous
                        file.rmdir(dirOrFile);
                    }
                },
                mv: function (start, end) {
                    return fs.renameSync(start, end);
                },
                mkdir: function (dir) {
                    return file.mkdirs(dir);
                },
                getFilteredFileList: function (startDir, regExpInclude, regExpExclude, dirRegExpExclude) {
                    return file.getFilteredFileList(resolve(startDir), regExpInclude, regExpExclude, dirRegExpExclude);
                },
                copyDir: function (srcDir, destDir, regExpFilter, onlyCopyNew) {
                    return file.copyDir(resolve(srcDir), resolve(destDir), regExpFilter, onlyCopyNew);
                },
                copyFile: function (srcFileName, destFileName, onlyCopyNew) {
                    return file.copyFile(resolve(srcFileName), resolve(destFileName), onlyCopyNew);
                },
                prompt: function (message, callback) {
                    var d = qutil.convert(callback);

                    function onData(data) {
                        data = (data || '').toString().trim();
                        process.stdin.pause();
                        d.resolve(data);
                    }

                    process.stdin.once('data', onData);
                    process.stdin.resume();

                    process.stdout.write(message + ' ', 'utf8');

                    return d.promise;
                },
                command: function () {
                    var args = [].slice.call(arguments, 0),
                        req = require,
                        d = q.defer();

                    req(['volo/main'], function (main) {
                        d.resolve(main(args));
                    });

                    return d.promise;
                },
                //Executes the text in the shell
                exec: function (text) {
                    var d = q.defer();

                    exec(text,
                        function (error, stdout, stderr) {
                            if (error) {
                                d.reject(error);
                            } else {
                                d.resolve();
                            }
                        }
                    );

                    return d.promise;
                }
            }
        };

        return instance;
    }

    return v;
});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint plusplus: false */
/*global define */

define('volo/commands',['require','./baseUrl','fs','path','q','volo/v'],function (require) {
    var baseUrl = require('./baseUrl'),
        fs = require('fs'),
        path = require('path'),
        q = require('q'),
        v = require('volo/v'),
        jsExtRegExp = /\.js$/,
        registry = {},
        commands;

    commands = {
        register: function (id, value) {
            //Only take the first part of the ID
            id = id.split('/')[0];

            registry[id] = value;
            return value;
        },

        have: function (name) {
            var hasCommand = name && registry.hasOwnProperty(name);
            if (!hasCommand) {
                //See if it is available on disk
                hasCommand = path.existsSync(path.join(baseUrl, name + '.js'));
            }

            return hasCommand;
        },

        list: function (callback) {
            var ids = [];

            if (path.existsSync(baseUrl)) {
                ids = fs.readdirSync(baseUrl);
                ids = ids.filter(function (filePath) {
                    return filePath.charAt(0) !== '.' && jsExtRegExp.test(filePath);
                }).map(function (filePath) {
                    return filePath.substring(0, filePath.length - 3);
                });
            }

            require(ids, function () {
                //All commands are loaded, list them out.
                var message = '',
                    ids, i;

                ids = Object.keys(registry);
                ids.sort();

                for (i = 0; i < ids.length; i++) {
                    message += ids[i] + ': ' + require(ids[i]).summary + '\n';
                }

                callback(message);
            });
        },

        run: function (command, venv, namedArgs /*other args can be passed*/) {
            var d = q.defer(),
                args;

            if (!venv) {
                venv = v(path.resolve('.')).env;
            }

            if (!command) {
                d.resolve();
            } else {
                if (typeof command === 'function') {
                    //Just normalize to advanced structure.
                    command = {
                        run: command
                    };
                }

                args = [].slice.call(arguments, 2);

                q.call(function () {
                    if (command.depends && command.depends.length) {
                        return command.depends.reduce(function (done, command) {
                            return q.wait(done,
                                          commands.run.apply(commands,
                                                        [command, venv].concat(args)));
                        });
                    }
                    return undefined;
                })
                .then(function () {
                    var commandDeferred = q.defer(),
                        err;

                    //Call validate if it is on the command.
                    if (command.validate) {
                        err = command.validate.apply(command, args);
                        if (err) {
                            commandDeferred.reject(err);
                            return commandDeferred.promise;
                        }
                    }

                    command.run.apply(command, [commandDeferred, venv].concat(args));
                    return commandDeferred.promise;
                })
                .then(d.resolve, d.reject);
            }

            return d.promise;
        }
    };

    return commands;
});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint */
/*global define, process */

/**
 * Reads a volofile from a target directory, and exports the data as a
 * set of modules.
 */
define('volo/volofile',['require','path','volo/commands','volo/qutil'],function (require) {
    var path = require('path'),
        commands = require('volo/commands'),
        qutil = require('volo/qutil');

    function volofile(basePath, callback, errback) {
        var d = qutil.convert(callback, errback),
            volofilePath = path.resolve(path.join(basePath, 'volofile'));

        if (path.existsSync(volofilePath)) {
            require([volofilePath], function (value) {
                d.resolve(value);
            });
        } else {
            d.resolve();
        }

        return d.promise;
    }

    /**
     * Loads the volofile inside basePath, and if there, and if it
     * supports the command, then runs it, running dependencies for
     * the command if specified.
     * @returns {Promise} that resolves to false exactly, otherwise it has the
     * commmand output, if any.
     */
    volofile.run = function (basePath, commandName, namedArgs /*other args can be passed*/) {
        var args = [].slice.call(arguments, 2),
            cwd = process.cwd();

        process.chdir(basePath);

        return volofile('.').then(function (vfMod) {
            var command = vfMod && vfMod[commandName];
            return commands.run.apply(commands, [command, null].concat(args));
        })
        .then(function (result) {
            process.chdir(cwd);
            return result;
        });
    };

    return volofile;
});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint plusplus: false */
/*global define, voloVersion, console, process */

define('volo/main',['require','./commands','./config','./volofile','path','q'],function (require) {
    var commands = require('./commands'),
        config = require('./config'),
        volofile = require('./volofile'),
        path = require('path'),
        q = require('q');

    function main(args, callback, errback) {
        var deferred = q.defer(),
            cwd = process.cwd(),
            namedArgs = {
                volo: {
                    resolve: function (relativePath) {
                        if (relativePath.indexOf('/') !== 0 &&
                            relativePath.indexOf(':') === -1) {
                            return path.resolve(cwd, relativePath);
                        }
                        return relativePath;
                    }
                }
            },
            aryArgs = [],
            flags = [],
            commandName, combinedArgs, commandOverride, firstArg;

        //Cycle through args, pulling off name=value pairs into an object.
        args.forEach(function (arg) {
            if (arg.indexOf('=') === -1) {
                //If passed a flag like -f, convert to named
                //argument based on the command's configuration.
                if (arg.indexOf('-') === 0) {
                    flags.push(arg.substring(1));
                } else {
                    //Regular array arg.
                    aryArgs.push(arg);
                }
            } else {
                var pair = arg.split('=');
                namedArgs[pair[0]] = pair[1];
            }
        });

        //The commandName will be the first arg.
        if (aryArgs.length) {
            //If first arg is a -flag or a name=value command skip it,
            //means a default volofile action should be run.
            firstArg = aryArgs[0];
            if (firstArg.indexOf('-') !== 0 && firstArg.indexOf('=') === -1) {
                commandName = aryArgs.shift();

                //If this is a specific override to bypase a volofile,
                //the next arg is the real command.
                if (commandName === 'command') {
                    commandOverride = true;
                    commandName = aryArgs.shift();
                }
            }
        }

        combinedArgs = [namedArgs].concat(aryArgs);

        //Function to run after the command object has been loaded, either
        //by a volofile or by installed volo actions.
        function runCommand(command) {
            //Really have the command. Now convert the flags into
            //named arguments.
            var hasFlagError = false;

            flags.some(function (flag) {
                if (command.flags && command.flags[flag]) {
                    namedArgs[command.flags[flag]] = true;
                } else {
                    hasFlagError = true;
                    deferred.reject('Invalid flag for ' + commandName + ': -' + flag);
                }

                return hasFlagError;
            });

            if (!hasFlagError) {
                commands.run.apply(commands, [command, null].concat(combinedArgs))
                    .then(deferred.resolve, deferred.reject);
            }
        }


        //Tries to run the command from the top, not from a local volofile.
        function runTopCommand() {
            if (commands.have(commandName)) {
                //a volo command is available, run it.
                require([commandName], runCommand);
            } else {
                //Show usage info.
                commands.list(function (message) {
                    //voloVersion set in tools/wrap.start
                    deferred.resolve(path.basename(config.volo.path) +
                                     (typeof voloVersion !== 'undefined' ?
                                        ' v' + voloVersion : '') +
                                    ', a JavaScript tool to make ' +
                                    'JavaScript projects. Allowed commands:\n\n' +
                                    message);
                });
            }
        }

        if (!commandOverride && path.existsSync(path.resolve(cwd, 'volofile'))) {
            volofile(cwd).then(function (voloMod) {
                //Set up default command name if none specified.
                commandName = commandName || 'run';

                if (voloMod.hasOwnProperty(commandName)) {
                    runCommand(voloMod[commandName]);
                } else {
                    runTopCommand();
                }
            })
            .fail(deferred.reject);
        } else {
            runTopCommand();
        }

        return q.when(deferred.promise, callback, errback);
    }

    return main;
});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint */
/*global define, console, process */

define('help',['require','exports','module','volo/commands','volo/commands'],function (require, exports, module) {
    var commands = require('volo/commands'),
        help;

    help = {
        summary: 'Gives more detailed help on a volo command.',

        doc: '##Usage\n\n    volo.js help commandName',

        validate: function (namedArgs, commandName) {
            if (!commandName) {
                return new Error('Please specify a command name to use help.');
            }

            if (!commands.have(commandName)) {
                return new Error(commandName + ' command does not exist. Do ' +
                                 'you need to *acquire* it?');
            }
            return undefined;
        },

        run: function (deferred, v, namedArgs, commandName) {

            require([commandName], function (command) {
                var doc = command.doc || command.summary ||
                          commandName + ' does not have any documentation.';

                deferred.resolve(doc);
            });
        }
    };

    return require('volo/commands').register(module.id, help);
});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint */
/*global define, console, process */

define('volo/tempDir',['require','path','fs','./file','./qutil'],function (require) {
    var path = require('path'),
        fs = require('fs'),
        file = require('./file'),
        qutil = require('./qutil'),
        counter = 0,
        tempDir;

    tempDir = {

        create: function (seed, callback, errback) {
            var temp = tempDir.createTempName(seed),
                d = qutil.convert(callback, errback);

            if (path.existsSync(temp)) {
                file.rmdir(temp, function () {
                    fs.mkdirSync(temp);
                    d.resolve(temp);
                }, d.reject);
            } else {
                fs.mkdirSync(temp);
                d.resolve(temp);
            }

            return d.promise;
        },

        createTempName: function (seed) {
            counter += 1;
            return seed.replace(/[\/\:]/g, '-') + '-temp-' + counter;
        }
    };

    return tempDir;
});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint plusplus: false */
/*global define, console */

define('volo/download',['require','https','http','fs','url','volo/qutil','volo/file'],function (require) {
    var https = require('https'),
        http = require('http'),
        fs = require('fs'),
        urlLib = require('url'),
        qutil = require('volo/qutil'),
        file = require('volo/file'),
        localRegExp = /^local\:/;

    function download(url, path, callback, errback) {
        var d = qutil.convert(callback, errback),
            parts, protocol, writeStream;

        try {
            //Handle local URLs
            if (localRegExp.test(url)) {
                url = url.substring(url.indexOf(':') + 1);
                file.copyDir(url, path);
                d.resolve(path);
            } else {

                //Do the network fetch.
                parts = urlLib.parse(url);
                protocol = parts.protocol === 'https:' ? https : http;
                writeStream = fs.createWriteStream(path);

                protocol.get(parts, function (response) {

                    //console.log("statusCode: ", response.statusCode);
                    //console.log("headers: ", response.headers);
                    try {
                        if (response.statusCode === 200) {

                            console.log('Downloading: ' + url);

                            //Bingo, do the download.
                            response.on('data', function (data) {
                                writeStream.write(data);
                            });

                            response.on('end', function () {
                                writeStream.end();
                                d.resolve(path);
                            });
                        } else if (response.statusCode === 302) {
                            //Redirect, try the new location
                            d.resolve(download(response.headers.location, path));
                        } else {
                            d.resolve(response);
                        }
                    } catch (e) {
                        d.reject(e);
                    }
                }).on('error', function (e) {
                    d.reject(e);
                });
            }
        } catch (e) {
            d.reject(e);
        }

        return d.promise;
    }

    return download;
});
/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint */
/*global define, console */

define('volo/tar',['require','child_process','path','volo/qutil'],function (require) {
    var exec = require('child_process').exec,
        path = require('path'),
        qutil = require('volo/qutil'),
        gzRegExp = /\.gz$/,
        tar;

    tar = {
        untar: function (fileName, callback, errback) {

            var flags = 'xf',
                dirName = path.dirname(fileName),
                d = qutil.convert(callback, errback),
                command;

            //If a .gz file add z to the flags.
            if (gzRegExp.test(fileName)) {
                flags = 'z' + flags;
            }

            command = 'tar -' + flags + ' ' + fileName;
            if (dirName) {
                command += ' -C ' + dirName;
            }

            exec(command,
                function (error, stdout, stderr) {
                    if (error) {
                        d.reject(error);
                    } else {
                        d.resolve();
                    }
                }
            );

            return d.promise;
        }
    };

    return tar;
});
/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint */
/*global define, console */

define('volo/packageJson',['require','path','fs'],function (require) {
    var path = require('path'),
        fs = require('fs'),
        commentRegExp = /\/\*package\.json([\s\S]*?)\*\//,
        endsInJsRegExp = /\.js$/;

    function extractCommentData(file) {
        var match = commentRegExp.exec(fs.readFileSync(file, 'utf8')),
            json = match && match[1] && match[1].trim();
        if (json) {
            return JSON.parse(json);
        } else {
            return null;
        }
    }

    function packageJson(fileOrDir) {
        var result = {
            file: null,
            data: null,
            singleFile: false
        },
        packagePath = path.join(fileOrDir, 'package.json'),
        jsFiles, filePath, packageData;

        if (fs.statSync(fileOrDir).isFile()) {
            //A .js file that may have a package.json content
            result.data = extractCommentData(fileOrDir);
            result.file = fileOrDir;
            result.singleFile = true;
        } else {
            //Check for /*package.json */ in a .js file if it is the
            //only .js file in the dir.
            jsFiles = fs.readdirSync(fileOrDir).filter(function (item) {
                return endsInJsRegExp.test(item);
            });

            if (jsFiles.length === 1) {
                filePath = path.join(fileOrDir, jsFiles[0]);
                packageData = extractCommentData(filePath);
            }

            if (packageData || !path.existsSync(packagePath)) {
                result.data = packageData;
                result.file = filePath;
                result.singleFile = true;
            } else if (path.existsSync(packagePath)) {
                //Plain package.json case
                packagePath = path.join(fileOrDir, 'package.json');
                result.file = packagePath;
                result.data = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
            }
        }

        return result;
    }


    return packageJson;
});

define('volo/uglifyjs/parse-js',["require", "exports", "module"], function(require, exports, module) {
/***********************************************************************

  A JavaScript tokenizer / parser / beautifier / compressor.

  This version is suitable for Node.js.  With minimal changes (the
  exports stuff) it should work on any JS platform.

  This file contains the tokenizer/parser.  It is a port to JavaScript
  of parse-js [1], a JavaScript parser library written in Common Lisp
  by Marijn Haverbeke.  Thank you Marijn!

  [1] http://marijn.haverbeke.nl/parse-js/

  Exported functions:

    - tokenizer(code) -- returns a function.  Call the returned
      function to fetch the next token.

    - parse(code) -- returns an AST of the given JavaScript code.

  -------------------------------- (C) ---------------------------------

                           Author: Mihai Bazon
                         <mihai.bazon@gmail.com>
                       http://mihai.bazon.net/blog

  Distributed under the BSD license:

    Copyright 2010 (c) Mihai Bazon <mihai.bazon@gmail.com>
    Based on parse-js (http://marijn.haverbeke.nl/parse-js/).

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions
    are met:

        * Redistributions of source code must retain the above
          copyright notice, this list of conditions and the following
          disclaimer.

        * Redistributions in binary form must reproduce the above
          copyright notice, this list of conditions and the following
          disclaimer in the documentation and/or other materials
          provided with the distribution.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDER “AS IS” AND ANY
    EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
    IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
    PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE
    LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY,
    OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
    PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
    PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
    THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
    TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF
    THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
    SUCH DAMAGE.

 ***********************************************************************/

/* -----[ Tokenizer (constants) ]----- */

var KEYWORDS = array_to_hash([
        "break",
        "case",
        "catch",
        "const",
        "continue",
        "default",
        "delete",
        "do",
        "else",
        "finally",
        "for",
        "function",
        "if",
        "in",
        "instanceof",
        "new",
        "return",
        "switch",
        "throw",
        "try",
        "typeof",
        "var",
        "void",
        "while",
        "with"
]);

var RESERVED_WORDS = array_to_hash([
        "abstract",
        "boolean",
        "byte",
        "char",
        "class",
        "debugger",
        "double",
        "enum",
        "export",
        "extends",
        "final",
        "float",
        "goto",
        "implements",
        "import",
        "int",
        "interface",
        "long",
        "native",
        "package",
        "private",
        "protected",
        "public",
        "short",
        "static",
        "super",
        "synchronized",
        "throws",
        "transient",
        "volatile"
]);

var KEYWORDS_BEFORE_EXPRESSION = array_to_hash([
        "return",
        "new",
        "delete",
        "throw",
        "else",
        "case"
]);

var KEYWORDS_ATOM = array_to_hash([
        "false",
        "null",
        "true",
        "undefined"
]);

var OPERATOR_CHARS = array_to_hash(characters("+-*&%=<>!?|~^"));

var RE_HEX_NUMBER = /^0x[0-9a-f]+$/i;
var RE_OCT_NUMBER = /^0[0-7]+$/;
var RE_DEC_NUMBER = /^\d*\.?\d*(?:e[+-]?\d*(?:\d\.?|\.?\d)\d*)?$/i;

var OPERATORS = array_to_hash([
        "in",
        "instanceof",
        "typeof",
        "new",
        "void",
        "delete",
        "++",
        "--",
        "+",
        "-",
        "!",
        "~",
        "&",
        "|",
        "^",
        "*",
        "/",
        "%",
        ">>",
        "<<",
        ">>>",
        "<",
        ">",
        "<=",
        ">=",
        "==",
        "===",
        "!=",
        "!==",
        "?",
        "=",
        "+=",
        "-=",
        "/=",
        "*=",
        "%=",
        ">>=",
        "<<=",
        ">>>=",
        "|=",
        "^=",
        "&=",
        "&&",
        "||"
]);

var WHITESPACE_CHARS = array_to_hash(characters(" \u00a0\n\r\t\f\u000b\u200b\u180e\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000"));

var PUNC_BEFORE_EXPRESSION = array_to_hash(characters("[{}(,.;:"));

var PUNC_CHARS = array_to_hash(characters("[]{}(),;:"));

var REGEXP_MODIFIERS = array_to_hash(characters("gmsiy"));

/* -----[ Tokenizer ]----- */

// regexps adapted from http://xregexp.com/plugins/#unicode
var UNICODE = {
        letter: new RegExp("[\\u0041-\\u005A\\u0061-\\u007A\\u00AA\\u00B5\\u00BA\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02C1\\u02C6-\\u02D1\\u02E0-\\u02E4\\u02EC\\u02EE\\u0370-\\u0374\\u0376\\u0377\\u037A-\\u037D\\u0386\\u0388-\\u038A\\u038C\\u038E-\\u03A1\\u03A3-\\u03F5\\u03F7-\\u0481\\u048A-\\u0523\\u0531-\\u0556\\u0559\\u0561-\\u0587\\u05D0-\\u05EA\\u05F0-\\u05F2\\u0621-\\u064A\\u066E\\u066F\\u0671-\\u06D3\\u06D5\\u06E5\\u06E6\\u06EE\\u06EF\\u06FA-\\u06FC\\u06FF\\u0710\\u0712-\\u072F\\u074D-\\u07A5\\u07B1\\u07CA-\\u07EA\\u07F4\\u07F5\\u07FA\\u0904-\\u0939\\u093D\\u0950\\u0958-\\u0961\\u0971\\u0972\\u097B-\\u097F\\u0985-\\u098C\\u098F\\u0990\\u0993-\\u09A8\\u09AA-\\u09B0\\u09B2\\u09B6-\\u09B9\\u09BD\\u09CE\\u09DC\\u09DD\\u09DF-\\u09E1\\u09F0\\u09F1\\u0A05-\\u0A0A\\u0A0F\\u0A10\\u0A13-\\u0A28\\u0A2A-\\u0A30\\u0A32\\u0A33\\u0A35\\u0A36\\u0A38\\u0A39\\u0A59-\\u0A5C\\u0A5E\\u0A72-\\u0A74\\u0A85-\\u0A8D\\u0A8F-\\u0A91\\u0A93-\\u0AA8\\u0AAA-\\u0AB0\\u0AB2\\u0AB3\\u0AB5-\\u0AB9\\u0ABD\\u0AD0\\u0AE0\\u0AE1\\u0B05-\\u0B0C\\u0B0F\\u0B10\\u0B13-\\u0B28\\u0B2A-\\u0B30\\u0B32\\u0B33\\u0B35-\\u0B39\\u0B3D\\u0B5C\\u0B5D\\u0B5F-\\u0B61\\u0B71\\u0B83\\u0B85-\\u0B8A\\u0B8E-\\u0B90\\u0B92-\\u0B95\\u0B99\\u0B9A\\u0B9C\\u0B9E\\u0B9F\\u0BA3\\u0BA4\\u0BA8-\\u0BAA\\u0BAE-\\u0BB9\\u0BD0\\u0C05-\\u0C0C\\u0C0E-\\u0C10\\u0C12-\\u0C28\\u0C2A-\\u0C33\\u0C35-\\u0C39\\u0C3D\\u0C58\\u0C59\\u0C60\\u0C61\\u0C85-\\u0C8C\\u0C8E-\\u0C90\\u0C92-\\u0CA8\\u0CAA-\\u0CB3\\u0CB5-\\u0CB9\\u0CBD\\u0CDE\\u0CE0\\u0CE1\\u0D05-\\u0D0C\\u0D0E-\\u0D10\\u0D12-\\u0D28\\u0D2A-\\u0D39\\u0D3D\\u0D60\\u0D61\\u0D7A-\\u0D7F\\u0D85-\\u0D96\\u0D9A-\\u0DB1\\u0DB3-\\u0DBB\\u0DBD\\u0DC0-\\u0DC6\\u0E01-\\u0E30\\u0E32\\u0E33\\u0E40-\\u0E46\\u0E81\\u0E82\\u0E84\\u0E87\\u0E88\\u0E8A\\u0E8D\\u0E94-\\u0E97\\u0E99-\\u0E9F\\u0EA1-\\u0EA3\\u0EA5\\u0EA7\\u0EAA\\u0EAB\\u0EAD-\\u0EB0\\u0EB2\\u0EB3\\u0EBD\\u0EC0-\\u0EC4\\u0EC6\\u0EDC\\u0EDD\\u0F00\\u0F40-\\u0F47\\u0F49-\\u0F6C\\u0F88-\\u0F8B\\u1000-\\u102A\\u103F\\u1050-\\u1055\\u105A-\\u105D\\u1061\\u1065\\u1066\\u106E-\\u1070\\u1075-\\u1081\\u108E\\u10A0-\\u10C5\\u10D0-\\u10FA\\u10FC\\u1100-\\u1159\\u115F-\\u11A2\\u11A8-\\u11F9\\u1200-\\u1248\\u124A-\\u124D\\u1250-\\u1256\\u1258\\u125A-\\u125D\\u1260-\\u1288\\u128A-\\u128D\\u1290-\\u12B0\\u12B2-\\u12B5\\u12B8-\\u12BE\\u12C0\\u12C2-\\u12C5\\u12C8-\\u12D6\\u12D8-\\u1310\\u1312-\\u1315\\u1318-\\u135A\\u1380-\\u138F\\u13A0-\\u13F4\\u1401-\\u166C\\u166F-\\u1676\\u1681-\\u169A\\u16A0-\\u16EA\\u1700-\\u170C\\u170E-\\u1711\\u1720-\\u1731\\u1740-\\u1751\\u1760-\\u176C\\u176E-\\u1770\\u1780-\\u17B3\\u17D7\\u17DC\\u1820-\\u1877\\u1880-\\u18A8\\u18AA\\u1900-\\u191C\\u1950-\\u196D\\u1970-\\u1974\\u1980-\\u19A9\\u19C1-\\u19C7\\u1A00-\\u1A16\\u1B05-\\u1B33\\u1B45-\\u1B4B\\u1B83-\\u1BA0\\u1BAE\\u1BAF\\u1C00-\\u1C23\\u1C4D-\\u1C4F\\u1C5A-\\u1C7D\\u1D00-\\u1DBF\\u1E00-\\u1F15\\u1F18-\\u1F1D\\u1F20-\\u1F45\\u1F48-\\u1F4D\\u1F50-\\u1F57\\u1F59\\u1F5B\\u1F5D\\u1F5F-\\u1F7D\\u1F80-\\u1FB4\\u1FB6-\\u1FBC\\u1FBE\\u1FC2-\\u1FC4\\u1FC6-\\u1FCC\\u1FD0-\\u1FD3\\u1FD6-\\u1FDB\\u1FE0-\\u1FEC\\u1FF2-\\u1FF4\\u1FF6-\\u1FFC\\u2071\\u207F\\u2090-\\u2094\\u2102\\u2107\\u210A-\\u2113\\u2115\\u2119-\\u211D\\u2124\\u2126\\u2128\\u212A-\\u212D\\u212F-\\u2139\\u213C-\\u213F\\u2145-\\u2149\\u214E\\u2183\\u2184\\u2C00-\\u2C2E\\u2C30-\\u2C5E\\u2C60-\\u2C6F\\u2C71-\\u2C7D\\u2C80-\\u2CE4\\u2D00-\\u2D25\\u2D30-\\u2D65\\u2D6F\\u2D80-\\u2D96\\u2DA0-\\u2DA6\\u2DA8-\\u2DAE\\u2DB0-\\u2DB6\\u2DB8-\\u2DBE\\u2DC0-\\u2DC6\\u2DC8-\\u2DCE\\u2DD0-\\u2DD6\\u2DD8-\\u2DDE\\u2E2F\\u3005\\u3006\\u3031-\\u3035\\u303B\\u303C\\u3041-\\u3096\\u309D-\\u309F\\u30A1-\\u30FA\\u30FC-\\u30FF\\u3105-\\u312D\\u3131-\\u318E\\u31A0-\\u31B7\\u31F0-\\u31FF\\u3400\\u4DB5\\u4E00\\u9FC3\\uA000-\\uA48C\\uA500-\\uA60C\\uA610-\\uA61F\\uA62A\\uA62B\\uA640-\\uA65F\\uA662-\\uA66E\\uA67F-\\uA697\\uA717-\\uA71F\\uA722-\\uA788\\uA78B\\uA78C\\uA7FB-\\uA801\\uA803-\\uA805\\uA807-\\uA80A\\uA80C-\\uA822\\uA840-\\uA873\\uA882-\\uA8B3\\uA90A-\\uA925\\uA930-\\uA946\\uAA00-\\uAA28\\uAA40-\\uAA42\\uAA44-\\uAA4B\\uAC00\\uD7A3\\uF900-\\uFA2D\\uFA30-\\uFA6A\\uFA70-\\uFAD9\\uFB00-\\uFB06\\uFB13-\\uFB17\\uFB1D\\uFB1F-\\uFB28\\uFB2A-\\uFB36\\uFB38-\\uFB3C\\uFB3E\\uFB40\\uFB41\\uFB43\\uFB44\\uFB46-\\uFBB1\\uFBD3-\\uFD3D\\uFD50-\\uFD8F\\uFD92-\\uFDC7\\uFDF0-\\uFDFB\\uFE70-\\uFE74\\uFE76-\\uFEFC\\uFF21-\\uFF3A\\uFF41-\\uFF5A\\uFF66-\\uFFBE\\uFFC2-\\uFFC7\\uFFCA-\\uFFCF\\uFFD2-\\uFFD7\\uFFDA-\\uFFDC]"),
        non_spacing_mark: new RegExp("[\\u0300-\\u036F\\u0483-\\u0487\\u0591-\\u05BD\\u05BF\\u05C1\\u05C2\\u05C4\\u05C5\\u05C7\\u0610-\\u061A\\u064B-\\u065E\\u0670\\u06D6-\\u06DC\\u06DF-\\u06E4\\u06E7\\u06E8\\u06EA-\\u06ED\\u0711\\u0730-\\u074A\\u07A6-\\u07B0\\u07EB-\\u07F3\\u0816-\\u0819\\u081B-\\u0823\\u0825-\\u0827\\u0829-\\u082D\\u0900-\\u0902\\u093C\\u0941-\\u0948\\u094D\\u0951-\\u0955\\u0962\\u0963\\u0981\\u09BC\\u09C1-\\u09C4\\u09CD\\u09E2\\u09E3\\u0A01\\u0A02\\u0A3C\\u0A41\\u0A42\\u0A47\\u0A48\\u0A4B-\\u0A4D\\u0A51\\u0A70\\u0A71\\u0A75\\u0A81\\u0A82\\u0ABC\\u0AC1-\\u0AC5\\u0AC7\\u0AC8\\u0ACD\\u0AE2\\u0AE3\\u0B01\\u0B3C\\u0B3F\\u0B41-\\u0B44\\u0B4D\\u0B56\\u0B62\\u0B63\\u0B82\\u0BC0\\u0BCD\\u0C3E-\\u0C40\\u0C46-\\u0C48\\u0C4A-\\u0C4D\\u0C55\\u0C56\\u0C62\\u0C63\\u0CBC\\u0CBF\\u0CC6\\u0CCC\\u0CCD\\u0CE2\\u0CE3\\u0D41-\\u0D44\\u0D4D\\u0D62\\u0D63\\u0DCA\\u0DD2-\\u0DD4\\u0DD6\\u0E31\\u0E34-\\u0E3A\\u0E47-\\u0E4E\\u0EB1\\u0EB4-\\u0EB9\\u0EBB\\u0EBC\\u0EC8-\\u0ECD\\u0F18\\u0F19\\u0F35\\u0F37\\u0F39\\u0F71-\\u0F7E\\u0F80-\\u0F84\\u0F86\\u0F87\\u0F90-\\u0F97\\u0F99-\\u0FBC\\u0FC6\\u102D-\\u1030\\u1032-\\u1037\\u1039\\u103A\\u103D\\u103E\\u1058\\u1059\\u105E-\\u1060\\u1071-\\u1074\\u1082\\u1085\\u1086\\u108D\\u109D\\u135F\\u1712-\\u1714\\u1732-\\u1734\\u1752\\u1753\\u1772\\u1773\\u17B7-\\u17BD\\u17C6\\u17C9-\\u17D3\\u17DD\\u180B-\\u180D\\u18A9\\u1920-\\u1922\\u1927\\u1928\\u1932\\u1939-\\u193B\\u1A17\\u1A18\\u1A56\\u1A58-\\u1A5E\\u1A60\\u1A62\\u1A65-\\u1A6C\\u1A73-\\u1A7C\\u1A7F\\u1B00-\\u1B03\\u1B34\\u1B36-\\u1B3A\\u1B3C\\u1B42\\u1B6B-\\u1B73\\u1B80\\u1B81\\u1BA2-\\u1BA5\\u1BA8\\u1BA9\\u1C2C-\\u1C33\\u1C36\\u1C37\\u1CD0-\\u1CD2\\u1CD4-\\u1CE0\\u1CE2-\\u1CE8\\u1CED\\u1DC0-\\u1DE6\\u1DFD-\\u1DFF\\u20D0-\\u20DC\\u20E1\\u20E5-\\u20F0\\u2CEF-\\u2CF1\\u2DE0-\\u2DFF\\u302A-\\u302F\\u3099\\u309A\\uA66F\\uA67C\\uA67D\\uA6F0\\uA6F1\\uA802\\uA806\\uA80B\\uA825\\uA826\\uA8C4\\uA8E0-\\uA8F1\\uA926-\\uA92D\\uA947-\\uA951\\uA980-\\uA982\\uA9B3\\uA9B6-\\uA9B9\\uA9BC\\uAA29-\\uAA2E\\uAA31\\uAA32\\uAA35\\uAA36\\uAA43\\uAA4C\\uAAB0\\uAAB2-\\uAAB4\\uAAB7\\uAAB8\\uAABE\\uAABF\\uAAC1\\uABE5\\uABE8\\uABED\\uFB1E\\uFE00-\\uFE0F\\uFE20-\\uFE26]"),
        space_combining_mark: new RegExp("[\\u0903\\u093E-\\u0940\\u0949-\\u094C\\u094E\\u0982\\u0983\\u09BE-\\u09C0\\u09C7\\u09C8\\u09CB\\u09CC\\u09D7\\u0A03\\u0A3E-\\u0A40\\u0A83\\u0ABE-\\u0AC0\\u0AC9\\u0ACB\\u0ACC\\u0B02\\u0B03\\u0B3E\\u0B40\\u0B47\\u0B48\\u0B4B\\u0B4C\\u0B57\\u0BBE\\u0BBF\\u0BC1\\u0BC2\\u0BC6-\\u0BC8\\u0BCA-\\u0BCC\\u0BD7\\u0C01-\\u0C03\\u0C41-\\u0C44\\u0C82\\u0C83\\u0CBE\\u0CC0-\\u0CC4\\u0CC7\\u0CC8\\u0CCA\\u0CCB\\u0CD5\\u0CD6\\u0D02\\u0D03\\u0D3E-\\u0D40\\u0D46-\\u0D48\\u0D4A-\\u0D4C\\u0D57\\u0D82\\u0D83\\u0DCF-\\u0DD1\\u0DD8-\\u0DDF\\u0DF2\\u0DF3\\u0F3E\\u0F3F\\u0F7F\\u102B\\u102C\\u1031\\u1038\\u103B\\u103C\\u1056\\u1057\\u1062-\\u1064\\u1067-\\u106D\\u1083\\u1084\\u1087-\\u108C\\u108F\\u109A-\\u109C\\u17B6\\u17BE-\\u17C5\\u17C7\\u17C8\\u1923-\\u1926\\u1929-\\u192B\\u1930\\u1931\\u1933-\\u1938\\u19B0-\\u19C0\\u19C8\\u19C9\\u1A19-\\u1A1B\\u1A55\\u1A57\\u1A61\\u1A63\\u1A64\\u1A6D-\\u1A72\\u1B04\\u1B35\\u1B3B\\u1B3D-\\u1B41\\u1B43\\u1B44\\u1B82\\u1BA1\\u1BA6\\u1BA7\\u1BAA\\u1C24-\\u1C2B\\u1C34\\u1C35\\u1CE1\\u1CF2\\uA823\\uA824\\uA827\\uA880\\uA881\\uA8B4-\\uA8C3\\uA952\\uA953\\uA983\\uA9B4\\uA9B5\\uA9BA\\uA9BB\\uA9BD-\\uA9C0\\uAA2F\\uAA30\\uAA33\\uAA34\\uAA4D\\uAA7B\\uABE3\\uABE4\\uABE6\\uABE7\\uABE9\\uABEA\\uABEC]"),
        connector_punctuation: new RegExp("[\\u005F\\u203F\\u2040\\u2054\\uFE33\\uFE34\\uFE4D-\\uFE4F\\uFF3F]")
};

function is_letter(ch) {
        return UNICODE.letter.test(ch);
};

function is_digit(ch) {
        ch = ch.charCodeAt(0);
        return ch >= 48 && ch <= 57; //XXX: find out if "UnicodeDigit" means something else than 0..9
};

function is_alphanumeric_char(ch) {
        return is_digit(ch) || is_letter(ch);
};

function is_unicode_combining_mark(ch) {
        return UNICODE.non_spacing_mark.test(ch) || UNICODE.space_combining_mark.test(ch);
};

function is_unicode_connector_punctuation(ch) {
        return UNICODE.connector_punctuation.test(ch);
};

function is_identifier_start(ch) {
        return ch == "$" || ch == "_" || is_letter(ch);
};

function is_identifier_char(ch) {
        return is_identifier_start(ch)
                || is_unicode_combining_mark(ch)
                || is_digit(ch)
                || is_unicode_connector_punctuation(ch)
                || ch == "\u200c" // zero-width non-joiner <ZWNJ>
                || ch == "\u200d" // zero-width joiner <ZWJ> (in my ECMA-262 PDF, this is also 200c)
        ;
};

function parse_js_number(num) {
        if (RE_HEX_NUMBER.test(num)) {
                return parseInt(num.substr(2), 16);
        } else if (RE_OCT_NUMBER.test(num)) {
                return parseInt(num.substr(1), 8);
        } else if (RE_DEC_NUMBER.test(num)) {
                return parseFloat(num);
        }
};

function JS_Parse_Error(message, line, col, pos) {
        this.message = message;
        this.line = line + 1;
        this.col = col + 1;
        this.pos = pos + 1;
        this.stack = new Error().stack;
};

JS_Parse_Error.prototype.toString = function() {
        return this.message + " (line: " + this.line + ", col: " + this.col + ", pos: " + this.pos + ")" + "\n\n" + this.stack;
};

function js_error(message, line, col, pos) {
        throw new JS_Parse_Error(message, line, col, pos);
};

function is_token(token, type, val) {
        return token.type == type && (val == null || token.value == val);
};

var EX_EOF = {};

function tokenizer($TEXT) {

        var S = {
                text            : $TEXT.replace(/\r\n?|[\n\u2028\u2029]/g, "\n").replace(/^\uFEFF/, ''),
                pos             : 0,
                tokpos          : 0,
                line            : 0,
                tokline         : 0,
                col             : 0,
                tokcol          : 0,
                newline_before  : false,
                regex_allowed   : false,
                comments_before : []
        };

        function peek() { return S.text.charAt(S.pos); };

        function next(signal_eof, in_string) {
                var ch = S.text.charAt(S.pos++);
                if (signal_eof && !ch)
                        throw EX_EOF;
                if (ch == "\n") {
                        S.newline_before = S.newline_before || !in_string;
                        ++S.line;
                        S.col = 0;
                } else {
                        ++S.col;
                }
                return ch;
        };

        function eof() {
                return !S.peek();
        };

        function find(what, signal_eof) {
                var pos = S.text.indexOf(what, S.pos);
                if (signal_eof && pos == -1) throw EX_EOF;
                return pos;
        };

        function start_token() {
                S.tokline = S.line;
                S.tokcol = S.col;
                S.tokpos = S.pos;
        };

        function token(type, value, is_comment) {
                S.regex_allowed = ((type == "operator" && !HOP(UNARY_POSTFIX, value)) ||
                                   (type == "keyword" && HOP(KEYWORDS_BEFORE_EXPRESSION, value)) ||
                                   (type == "punc" && HOP(PUNC_BEFORE_EXPRESSION, value)));
                var ret = {
                        type   : type,
                        value  : value,
                        line   : S.tokline,
                        col    : S.tokcol,
                        pos    : S.tokpos,
                        endpos : S.pos,
                        nlb    : S.newline_before
                };
                if (!is_comment) {
                        ret.comments_before = S.comments_before;
                        S.comments_before = [];
                }
                S.newline_before = false;
                return ret;
        };

        function skip_whitespace() {
                while (HOP(WHITESPACE_CHARS, peek()))
                        next();
        };

        function read_while(pred) {
                var ret = "", ch = peek(), i = 0;
                while (ch && pred(ch, i++)) {
                        ret += next();
                        ch = peek();
                }
                return ret;
        };

        function parse_error(err) {
                js_error(err, S.tokline, S.tokcol, S.tokpos);
        };

        function read_num(prefix) {
                var has_e = false, after_e = false, has_x = false, has_dot = prefix == ".";
                var num = read_while(function(ch, i){
                        if (ch == "x" || ch == "X") {
                                if (has_x) return false;
                                return has_x = true;
                        }
                        if (!has_x && (ch == "E" || ch == "e")) {
                                if (has_e) return false;
                                return has_e = after_e = true;
                        }
                        if (ch == "-") {
                                if (after_e || (i == 0 && !prefix)) return true;
                                return false;
                        }
                        if (ch == "+") return after_e;
                        after_e = false;
                        if (ch == ".") {
                                if (!has_dot && !has_x)
                                        return has_dot = true;
                                return false;
                        }
                        return is_alphanumeric_char(ch);
                });
                if (prefix)
                        num = prefix + num;
                var valid = parse_js_number(num);
                if (!isNaN(valid)) {
                        return token("num", valid);
                } else {
                        parse_error("Invalid syntax: " + num);
                }
        };

        function read_escaped_char(in_string) {
                var ch = next(true, in_string);
                switch (ch) {
                    case "n" : return "\n";
                    case "r" : return "\r";
                    case "t" : return "\t";
                    case "b" : return "\b";
                    case "v" : return "\u000b";
                    case "f" : return "\f";
                    case "0" : return "\0";
                    case "x" : return String.fromCharCode(hex_bytes(2));
                    case "u" : return String.fromCharCode(hex_bytes(4));
                    case "\n": return "";
                    default  : return ch;
                }
        };

        function hex_bytes(n) {
                var num = 0;
                for (; n > 0; --n) {
                        var digit = parseInt(next(true), 16);
                        if (isNaN(digit))
                                parse_error("Invalid hex-character pattern in string");
                        num = (num << 4) | digit;
                }
                return num;
        };

        function read_string() {
                return with_eof_error("Unterminated string constant", function(){
                        var quote = next(), ret = "";
                        for (;;) {
                                var ch = next(true);
                                if (ch == "\\") {
                                        // read OctalEscapeSequence (XXX: deprecated if "strict mode")
                                        // https://github.com/mishoo/UglifyJS/issues/178
                                        var octal_len = 0, first = null;
                                        ch = read_while(function(ch){
                                                if (ch >= "0" && ch <= "7") {
                                                        if (!first) {
                                                                first = ch;
                                                                return ++octal_len;
                                                        }
                                                        else if (first <= "3" && octal_len <= 2) return ++octal_len;
                                                        else if (first >= "4" && octal_len <= 1) return ++octal_len;
                                                }
                                                return false;
                                        });
                                        if (octal_len > 0) ch = String.fromCharCode(parseInt(ch, 8));
                                        else ch = read_escaped_char(true);
                                }
                                else if (ch == quote) break;
                                ret += ch;
                        }
                        return token("string", ret);
                });
        };

        function read_line_comment() {
                next();
                var i = find("\n"), ret;
                if (i == -1) {
                        ret = S.text.substr(S.pos);
                        S.pos = S.text.length;
                } else {
                        ret = S.text.substring(S.pos, i);
                        S.pos = i;
                }
                return token("comment1", ret, true);
        };

        function read_multiline_comment() {
                next();
                return with_eof_error("Unterminated multiline comment", function(){
                        var i = find("*/", true),
                            text = S.text.substring(S.pos, i);
                        S.pos = i + 2;
                        S.line += text.split("\n").length - 1;
                        S.newline_before = text.indexOf("\n") >= 0;

                        // https://github.com/mishoo/UglifyJS/issues/#issue/100
                        if (/^@cc_on/i.test(text)) {
                                warn("WARNING: at line " + S.line);
                                warn("*** Found \"conditional comment\": " + text);
                                warn("*** UglifyJS DISCARDS ALL COMMENTS.  This means your code might no longer work properly in Internet Explorer.");
                        }

                        return token("comment2", text, true);
                });
        };

        function read_name() {
                var backslash = false, name = "", ch;
                while ((ch = peek()) != null) {
                        if (!backslash) {
                                if (ch == "\\") backslash = true, next();
                                else if (is_identifier_char(ch)) name += next();
                                else break;
                        }
                        else {
                                if (ch != "u") parse_error("Expecting UnicodeEscapeSequence -- uXXXX");
                                ch = read_escaped_char();
                                if (!is_identifier_char(ch)) parse_error("Unicode char: " + ch.charCodeAt(0) + " is not valid in identifier");
                                name += ch;
                                backslash = false;
                        }
                }
                return name;
        };

        function read_regexp(regexp) {
                return with_eof_error("Unterminated regular expression", function(){
                        var prev_backslash = false, ch, in_class = false;
                        while ((ch = next(true))) if (prev_backslash) {
                                regexp += "\\" + ch;
                                prev_backslash = false;
                        } else if (ch == "[") {
                                in_class = true;
                                regexp += ch;
                        } else if (ch == "]" && in_class) {
                                in_class = false;
                                regexp += ch;
                        } else if (ch == "/" && !in_class) {
                                break;
                        } else if (ch == "\\") {
                                prev_backslash = true;
                        } else {
                                regexp += ch;
                        }
                        var mods = read_name();
                        return token("regexp", [ regexp, mods ]);
                });
        };

        function read_operator(prefix) {
                function grow(op) {
                        if (!peek()) return op;
                        var bigger = op + peek();
                        if (HOP(OPERATORS, bigger)) {
                                next();
                                return grow(bigger);
                        } else {
                                return op;
                        }
                };
                return token("operator", grow(prefix || next()));
        };

        function handle_slash() {
                next();
                var regex_allowed = S.regex_allowed;
                switch (peek()) {
                    case "/":
                        S.comments_before.push(read_line_comment());
                        S.regex_allowed = regex_allowed;
                        return next_token();
                    case "*":
                        S.comments_before.push(read_multiline_comment());
                        S.regex_allowed = regex_allowed;
                        return next_token();
                }
                return S.regex_allowed ? read_regexp("") : read_operator("/");
        };

        function handle_dot() {
                next();
                return is_digit(peek())
                        ? read_num(".")
                        : token("punc", ".");
        };

        function read_word() {
                var word = read_name();
                return !HOP(KEYWORDS, word)
                        ? token("name", word)
                        : HOP(OPERATORS, word)
                        ? token("operator", word)
                        : HOP(KEYWORDS_ATOM, word)
                        ? token("atom", word)
                        : token("keyword", word);
        };

        function with_eof_error(eof_error, cont) {
                try {
                        return cont();
                } catch(ex) {
                        if (ex === EX_EOF) parse_error(eof_error);
                        else throw ex;
                }
        };

        function next_token(force_regexp) {
                if (force_regexp != null)
                        return read_regexp(force_regexp);
                skip_whitespace();
                start_token();
                var ch = peek();
                if (!ch) return token("eof");
                if (is_digit(ch)) return read_num();
                if (ch == '"' || ch == "'") return read_string();
                if (HOP(PUNC_CHARS, ch)) return token("punc", next());
                if (ch == ".") return handle_dot();
                if (ch == "/") return handle_slash();
                if (HOP(OPERATOR_CHARS, ch)) return read_operator();
                if (ch == "\\" || is_identifier_start(ch)) return read_word();
                parse_error("Unexpected character '" + ch + "'");
        };

        next_token.context = function(nc) {
                if (nc) S = nc;
                return S;
        };

        return next_token;

};

/* -----[ Parser (constants) ]----- */

var UNARY_PREFIX = array_to_hash([
        "typeof",
        "void",
        "delete",
        "--",
        "++",
        "!",
        "~",
        "-",
        "+"
]);

var UNARY_POSTFIX = array_to_hash([ "--", "++" ]);

var ASSIGNMENT = (function(a, ret, i){
        while (i < a.length) {
                ret[a[i]] = a[i].substr(0, a[i].length - 1);
                i++;
        }
        return ret;
})(
        ["+=", "-=", "/=", "*=", "%=", ">>=", "<<=", ">>>=", "|=", "^=", "&="],
        { "=": true },
        0
);

var PRECEDENCE = (function(a, ret){
        for (var i = 0, n = 1; i < a.length; ++i, ++n) {
                var b = a[i];
                for (var j = 0; j < b.length; ++j) {
                        ret[b[j]] = n;
                }
        }
        return ret;
})(
        [
                ["||"],
                ["&&"],
                ["|"],
                ["^"],
                ["&"],
                ["==", "===", "!=", "!=="],
                ["<", ">", "<=", ">=", "in", "instanceof"],
                [">>", "<<", ">>>"],
                ["+", "-"],
                ["*", "/", "%"]
        ],
        {}
);

var STATEMENTS_WITH_LABELS = array_to_hash([ "for", "do", "while", "switch" ]);

var ATOMIC_START_TOKEN = array_to_hash([ "atom", "num", "string", "regexp", "name" ]);

/* -----[ Parser ]----- */

function NodeWithToken(str, start, end) {
        this.name = str;
        this.start = start;
        this.end = end;
};

NodeWithToken.prototype.toString = function() { return this.name; };

function parse($TEXT, exigent_mode, embed_tokens) {

        var S = {
                input       : typeof $TEXT == "string" ? tokenizer($TEXT, true) : $TEXT,
                token       : null,
                prev        : null,
                peeked      : null,
                in_function : 0,
                in_loop     : 0,
                labels      : []
        };

        S.token = next();

        function is(type, value) {
                return is_token(S.token, type, value);
        };

        function peek() { return S.peeked || (S.peeked = S.input()); };

        function next() {
                S.prev = S.token;
                if (S.peeked) {
                        S.token = S.peeked;
                        S.peeked = null;
                } else {
                        S.token = S.input();
                }
                return S.token;
        };

        function prev() {
                return S.prev;
        };

        function croak(msg, line, col, pos) {
                var ctx = S.input.context();
                js_error(msg,
                         line != null ? line : ctx.tokline,
                         col != null ? col : ctx.tokcol,
                         pos != null ? pos : ctx.tokpos);
        };

        function token_error(token, msg) {
                croak(msg, token.line, token.col);
        };

        function unexpected(token) {
                if (token == null)
                        token = S.token;
                token_error(token, "Unexpected token: " + token.type + " (" + token.value + ")");
        };

        function expect_token(type, val) {
                if (is(type, val)) {
                        return next();
                }
                token_error(S.token, "Unexpected token " + S.token.type + ", expected " + type);
        };

        function expect(punc) { return expect_token("punc", punc); };

        function can_insert_semicolon() {
                return !exigent_mode && (
                        S.token.nlb || is("eof") || is("punc", "}")
                );
        };

        function semicolon() {
                if (is("punc", ";")) next();
                else if (!can_insert_semicolon()) unexpected();
        };

        function as() {
                return slice(arguments);
        };

        function parenthesised() {
                expect("(");
                var ex = expression();
                expect(")");
                return ex;
        };

        function add_tokens(str, start, end) {
                return str instanceof NodeWithToken ? str : new NodeWithToken(str, start, end);
        };

        function maybe_embed_tokens(parser) {
                if (embed_tokens) return function() {
                        var start = S.token;
                        var ast = parser.apply(this, arguments);
                        ast[0] = add_tokens(ast[0], start, prev());
                        return ast;
                };
                else return parser;
        };

        var statement = maybe_embed_tokens(function() {
                if (is("operator", "/") || is("operator", "/=")) {
                        S.peeked = null;
                        S.token = S.input(S.token.value.substr(1)); // force regexp
                }
                switch (S.token.type) {
                    case "num":
                    case "string":
                    case "regexp":
                    case "operator":
                    case "atom":
                        return simple_statement();

                    case "name":
                        return is_token(peek(), "punc", ":")
                                ? labeled_statement(prog1(S.token.value, next, next))
                                : simple_statement();

                    case "punc":
                        switch (S.token.value) {
                            case "{":
                                return as("block", block_());
                            case "[":
                            case "(":
                                return simple_statement();
                            case ";":
                                next();
                                return as("block");
                            default:
                                unexpected();
                        }

                    case "keyword":
                        switch (prog1(S.token.value, next)) {
                            case "break":
                                return break_cont("break");

                            case "continue":
                                return break_cont("continue");

                            case "debugger":
                                semicolon();
                                return as("debugger");

                            case "do":
                                return (function(body){
                                        expect_token("keyword", "while");
                                        return as("do", prog1(parenthesised, semicolon), body);
                                })(in_loop(statement));

                            case "for":
                                return for_();

                            case "function":
                                return function_(true);

                            case "if":
                                return if_();

                            case "return":
                                if (S.in_function == 0)
                                        croak("'return' outside of function");
                                return as("return",
                                          is("punc", ";")
                                          ? (next(), null)
                                          : can_insert_semicolon()
                                          ? null
                                          : prog1(expression, semicolon));

                            case "switch":
                                return as("switch", parenthesised(), switch_block_());

                            case "throw":
                                if (S.token.nlb)
                                        croak("Illegal newline after 'throw'");
                                return as("throw", prog1(expression, semicolon));

                            case "try":
                                return try_();

                            case "var":
                                return prog1(var_, semicolon);

                            case "const":
                                return prog1(const_, semicolon);

                            case "while":
                                return as("while", parenthesised(), in_loop(statement));

                            case "with":
                                return as("with", parenthesised(), statement());

                            default:
                                unexpected();
                        }
                }
        });

        function labeled_statement(label) {
                S.labels.push(label);
                var start = S.token, stat = statement();
                if (exigent_mode && !HOP(STATEMENTS_WITH_LABELS, stat[0]))
                        unexpected(start);
                S.labels.pop();
                return as("label", label, stat);
        };

        function simple_statement() {
                return as("stat", prog1(expression, semicolon));
        };

        function break_cont(type) {
                var name;
                if (!can_insert_semicolon()) {
                        name = is("name") ? S.token.value : null;
                }
                if (name != null) {
                        next();
                        if (!member(name, S.labels))
                                croak("Label " + name + " without matching loop or statement");
                }
                else if (S.in_loop == 0)
                        croak(type + " not inside a loop or switch");
                semicolon();
                return as(type, name);
        };

        function for_() {
                expect("(");
                var init = null;
                if (!is("punc", ";")) {
                        init = is("keyword", "var")
                                ? (next(), var_(true))
                                : expression(true, true);
                        if (is("operator", "in"))
                                return for_in(init);
                }
                return regular_for(init);
        };

        function regular_for(init) {
                expect(";");
                var test = is("punc", ";") ? null : expression();
                expect(";");
                var step = is("punc", ")") ? null : expression();
                expect(")");
                return as("for", init, test, step, in_loop(statement));
        };

        function for_in(init) {
                var lhs = init[0] == "var" ? as("name", init[1][0]) : init;
                next();
                var obj = expression();
                expect(")");
                return as("for-in", init, lhs, obj, in_loop(statement));
        };

        var function_ = function(in_statement) {
                var name = is("name") ? prog1(S.token.value, next) : null;
                if (in_statement && !name)
                        unexpected();
                expect("(");
                return as(in_statement ? "defun" : "function",
                          name,
                          // arguments
                          (function(first, a){
                                  while (!is("punc", ")")) {
                                          if (first) first = false; else expect(",");
                                          if (!is("name")) unexpected();
                                          a.push(S.token.value);
                                          next();
                                  }
                                  next();
                                  return a;
                          })(true, []),
                          // body
                          (function(){
                                  ++S.in_function;
                                  var loop = S.in_loop;
                                  S.in_loop = 0;
                                  var a = block_();
                                  --S.in_function;
                                  S.in_loop = loop;
                                  return a;
                          })());
        };

        function if_() {
                var cond = parenthesised(), body = statement(), belse;
                if (is("keyword", "else")) {
                        next();
                        belse = statement();
                }
                return as("if", cond, body, belse);
        };

        function block_() {
                expect("{");
                var a = [];
                while (!is("punc", "}")) {
                        if (is("eof")) unexpected();
                        a.push(statement());
                }
                next();
                return a;
        };

        var switch_block_ = curry(in_loop, function(){
                expect("{");
                var a = [], cur = null;
                while (!is("punc", "}")) {
                        if (is("eof")) unexpected();
                        if (is("keyword", "case")) {
                                next();
                                cur = [];
                                a.push([ expression(), cur ]);
                                expect(":");
                        }
                        else if (is("keyword", "default")) {
                                next();
                                expect(":");
                                cur = [];
                                a.push([ null, cur ]);
                        }
                        else {
                                if (!cur) unexpected();
                                cur.push(statement());
                        }
                }
                next();
                return a;
        });

        function try_() {
                var body = block_(), bcatch, bfinally;
                if (is("keyword", "catch")) {
                        next();
                        expect("(");
                        if (!is("name"))
                                croak("Name expected");
                        var name = S.token.value;
                        next();
                        expect(")");
                        bcatch = [ name, block_() ];
                }
                if (is("keyword", "finally")) {
                        next();
                        bfinally = block_();
                }
                if (!bcatch && !bfinally)
                        croak("Missing catch/finally blocks");
                return as("try", body, bcatch, bfinally);
        };

        function vardefs(no_in) {
                var a = [];
                for (;;) {
                        if (!is("name"))
                                unexpected();
                        var name = S.token.value;
                        next();
                        if (is("operator", "=")) {
                                next();
                                a.push([ name, expression(false, no_in) ]);
                        } else {
                                a.push([ name ]);
                        }
                        if (!is("punc", ","))
                                break;
                        next();
                }
                return a;
        };

        function var_(no_in) {
                return as("var", vardefs(no_in));
        };

        function const_() {
                return as("const", vardefs());
        };

        function new_() {
                var newexp = expr_atom(false), args;
                if (is("punc", "(")) {
                        next();
                        args = expr_list(")");
                } else {
                        args = [];
                }
                return subscripts(as("new", newexp, args), true);
        };

        var expr_atom = maybe_embed_tokens(function(allow_calls) {
                if (is("operator", "new")) {
                        next();
                        return new_();
                }
                if (is("punc")) {
                        switch (S.token.value) {
                            case "(":
                                next();
                                return subscripts(prog1(expression, curry(expect, ")")), allow_calls);
                            case "[":
                                next();
                                return subscripts(array_(), allow_calls);
                            case "{":
                                next();
                                return subscripts(object_(), allow_calls);
                        }
                        unexpected();
                }
                if (is("keyword", "function")) {
                        next();
                        return subscripts(function_(false), allow_calls);
                }
                if (HOP(ATOMIC_START_TOKEN, S.token.type)) {
                        var atom = S.token.type == "regexp"
                                ? as("regexp", S.token.value[0], S.token.value[1])
                                : as(S.token.type, S.token.value);
                        return subscripts(prog1(atom, next), allow_calls);
                }
                unexpected();
        });

        function expr_list(closing, allow_trailing_comma, allow_empty) {
                var first = true, a = [];
                while (!is("punc", closing)) {
                        if (first) first = false; else expect(",");
                        if (allow_trailing_comma && is("punc", closing)) break;
                        if (is("punc", ",") && allow_empty) {
                                a.push([ "atom", "undefined" ]);
                        } else {
                                a.push(expression(false));
                        }
                }
                next();
                return a;
        };

        function array_() {
                return as("array", expr_list("]", !exigent_mode, true));
        };

        function object_() {
                var first = true, a = [];
                while (!is("punc", "}")) {
                        if (first) first = false; else expect(",");
                        if (!exigent_mode && is("punc", "}"))
                                // allow trailing comma
                                break;
                        var type = S.token.type;
                        var name = as_property_name();
                        if (type == "name" && (name == "get" || name == "set") && !is("punc", ":")) {
                                a.push([ as_name(), function_(false), name ]);
                        } else {
                                expect(":");
                                a.push([ name, expression(false) ]);
                        }
                }
                next();
                return as("object", a);
        };

        function as_property_name() {
                switch (S.token.type) {
                    case "num":
                    case "string":
                        return prog1(S.token.value, next);
                }
                return as_name();
        };

        function as_name() {
                switch (S.token.type) {
                    case "name":
                    case "operator":
                    case "keyword":
                    case "atom":
                        return prog1(S.token.value, next);
                    default:
                        unexpected();
                }
        };

        function subscripts(expr, allow_calls) {
                if (is("punc", ".")) {
                        next();
                        return subscripts(as("dot", expr, as_name()), allow_calls);
                }
                if (is("punc", "[")) {
                        next();
                        return subscripts(as("sub", expr, prog1(expression, curry(expect, "]"))), allow_calls);
                }
                if (allow_calls && is("punc", "(")) {
                        next();
                        return subscripts(as("call", expr, expr_list(")")), true);
                }
                return expr;
        };

        function maybe_unary(allow_calls) {
                if (is("operator") && HOP(UNARY_PREFIX, S.token.value)) {
                        return make_unary("unary-prefix",
                                          prog1(S.token.value, next),
                                          maybe_unary(allow_calls));
                }
                var val = expr_atom(allow_calls);
                while (is("operator") && HOP(UNARY_POSTFIX, S.token.value) && !S.token.nlb) {
                        val = make_unary("unary-postfix", S.token.value, val);
                        next();
                }
                return val;
        };

        function make_unary(tag, op, expr) {
                if ((op == "++" || op == "--") && !is_assignable(expr))
                        croak("Invalid use of " + op + " operator");
                return as(tag, op, expr);
        };

        function expr_op(left, min_prec, no_in) {
                var op = is("operator") ? S.token.value : null;
                if (op && op == "in" && no_in) op = null;
                var prec = op != null ? PRECEDENCE[op] : null;
                if (prec != null && prec > min_prec) {
                        next();
                        var right = expr_op(maybe_unary(true), prec, no_in);
                        return expr_op(as("binary", op, left, right), min_prec, no_in);
                }
                return left;
        };

        function expr_ops(no_in) {
                return expr_op(maybe_unary(true), 0, no_in);
        };

        function maybe_conditional(no_in) {
                var expr = expr_ops(no_in);
                if (is("operator", "?")) {
                        next();
                        var yes = expression(false);
                        expect(":");
                        return as("conditional", expr, yes, expression(false, no_in));
                }
                return expr;
        };

        function is_assignable(expr) {
                if (!exigent_mode) return true;
                switch (expr[0]+"") {
                    case "dot":
                    case "sub":
                    case "new":
                    case "call":
                        return true;
                    case "name":
                        return expr[1] != "this";
                }
        };

        function maybe_assign(no_in) {
                var left = maybe_conditional(no_in), val = S.token.value;
                if (is("operator") && HOP(ASSIGNMENT, val)) {
                        if (is_assignable(left)) {
                                next();
                                return as("assign", ASSIGNMENT[val], left, maybe_assign(no_in));
                        }
                        croak("Invalid assignment");
                }
                return left;
        };

        var expression = maybe_embed_tokens(function(commas, no_in) {
                if (arguments.length == 0)
                        commas = true;
                var expr = maybe_assign(no_in);
                if (commas && is("punc", ",")) {
                        next();
                        return as("seq", expr, expression(true, no_in));
                }
                return expr;
        });

        function in_loop(cont) {
                try {
                        ++S.in_loop;
                        return cont();
                } finally {
                        --S.in_loop;
                }
        };

        return as("toplevel", (function(a){
                while (!is("eof"))
                        a.push(statement());
                return a;
        })([]));

};

/* -----[ Utilities ]----- */

function curry(f) {
        var args = slice(arguments, 1);
        return function() { return f.apply(this, args.concat(slice(arguments))); };
};

function prog1(ret) {
        if (ret instanceof Function)
                ret = ret();
        for (var i = 1, n = arguments.length; --n > 0; ++i)
                arguments[i]();
        return ret;
};

function array_to_hash(a) {
        var ret = {};
        for (var i = 0; i < a.length; ++i)
                ret[a[i]] = true;
        return ret;
};

function slice(a, start) {
        return Array.prototype.slice.call(a, start || 0);
};

function characters(str) {
        return str.split("");
};

function member(name, array) {
        for (var i = array.length; --i >= 0;)
                if (array[i] == name)
                        return true;
        return false;
};

function HOP(obj, prop) {
        return Object.prototype.hasOwnProperty.call(obj, prop);
};

var warn = function() {};

/* -----[ Exports ]----- */

exports.tokenizer = tokenizer;
exports.parse = parse;
exports.slice = slice;
exports.curry = curry;
exports.member = member;
exports.array_to_hash = array_to_hash;
exports.PRECEDENCE = PRECEDENCE;
exports.KEYWORDS_ATOM = KEYWORDS_ATOM;
exports.RESERVED_WORDS = RESERVED_WORDS;
exports.KEYWORDS = KEYWORDS;
exports.ATOMIC_START_TOKEN = ATOMIC_START_TOKEN;
exports.OPERATORS = OPERATORS;
exports.is_alphanumeric_char = is_alphanumeric_char;
exports.set_logger = function(logger) {
        warn = logger;
};

});

/**
 * @license RequireJS text 1.0.2 Copyright (c) 2010-2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/jrburke/requirejs for details
 */
/*jslint regexp: false, nomen: false, plusplus: false, strict: false */
/*global require: false, XMLHttpRequest: false, ActiveXObject: false,
  define: false, window: false, process: false, Packages: false,
  java: false, location: false */

(function () {
    var progIds = ['Msxml2.XMLHTTP', 'Microsoft.XMLHTTP', 'Msxml2.XMLHTTP.4.0'],
        xmlRegExp = /^\s*<\?xml(\s)+version=[\'\"](\d)*.(\d)*[\'\"](\s)*\?>/im,
        bodyRegExp = /<body[^>]*>\s*([\s\S]+)\s*<\/body>/im,
        hasLocation = typeof location !== 'undefined' && location.href,
        defaultProtocol = hasLocation && location.protocol && location.protocol.replace(/\:/, ''),
        defaultHostName = hasLocation && location.hostname,
        defaultPort = hasLocation && (location.port || undefined),
        buildMap = [];

    define('text',[],function () {
        var text, get, fs;

        if (typeof window !== "undefined" && window.navigator && window.document) {
            get = function (url, callback) {
                var xhr = text.createXhr();
                xhr.open('GET', url, true);
                xhr.onreadystatechange = function (evt) {
                    //Do not explicitly handle errors, those should be
                    //visible via console output in the browser.
                    if (xhr.readyState === 4) {
                        callback(xhr.responseText);
                    }
                };
                xhr.send(null);
            };
        } else if (typeof process !== "undefined" &&
                 process.versions &&
                 !!process.versions.node) {
            //Using special require.nodeRequire, something added by r.js.
            fs = (require.nodeRequire || require)('fs');

            get = function (url, callback) {
                callback(fs.readFileSync(url, 'utf8'));
            };
        } else if (typeof Packages !== 'undefined') {
            //Why Java, why is this so awkward?
            get = function (url, callback) {
                var encoding = "utf-8",
                    file = new java.io.File(url),
                    lineSeparator = java.lang.System.getProperty("line.separator"),
                    input = new java.io.BufferedReader(new java.io.InputStreamReader(new java.io.FileInputStream(file), encoding)),
                    stringBuffer, line,
                    content = '';
                try {
                    stringBuffer = new java.lang.StringBuffer();
                    line = input.readLine();

                    // Byte Order Mark (BOM) - The Unicode Standard, version 3.0, page 324
                    // http://www.unicode.org/faq/utf_bom.html

                    // Note that when we use utf-8, the BOM should appear as "EF BB BF", but it doesn't due to this bug in the JDK:
                    // http://bugs.sun.com/bugdatabase/view_bug.do?bug_id=4508058
                    if (line && line.length() && line.charAt(0) === 0xfeff) {
                        // Eat the BOM, since we've already found the encoding on this file,
                        // and we plan to concatenating this buffer with others; the BOM should
                        // only appear at the top of a file.
                        line = line.substring(1);
                    }

                    stringBuffer.append(line);

                    while ((line = input.readLine()) !== null) {
                        stringBuffer.append(lineSeparator);
                        stringBuffer.append(line);
                    }
                    //Make sure we return a JavaScript string and not a Java string.
                    content = String(stringBuffer.toString()); //String
                } finally {
                    input.close();
                }
                callback(content);
            };
        }

        text = {
            version: '1.0.2',

            strip: function (content) {
                //Strips <?xml ...?> declarations so that external SVG and XML
                //documents can be added to a document without worry. Also, if the string
                //is an HTML document, only the part inside the body tag is returned.
                if (content) {
                    content = content.replace(xmlRegExp, "");
                    var matches = content.match(bodyRegExp);
                    if (matches) {
                        content = matches[1];
                    }
                } else {
                    content = "";
                }
                return content;
            },

            jsEscape: function (content) {
                return content.replace(/(['\\])/g, '\\$1')
                    .replace(/[\f]/g, "\\f")
                    .replace(/[\b]/g, "\\b")
                    .replace(/[\n]/g, "\\n")
                    .replace(/[\t]/g, "\\t")
                    .replace(/[\r]/g, "\\r");
            },

            createXhr: function () {
                //Would love to dump the ActiveX crap in here. Need IE 6 to die first.
                var xhr, i, progId;
                if (typeof XMLHttpRequest !== "undefined") {
                    return new XMLHttpRequest();
                } else {
                    for (i = 0; i < 3; i++) {
                        progId = progIds[i];
                        try {
                            xhr = new ActiveXObject(progId);
                        } catch (e) {}

                        if (xhr) {
                            progIds = [progId];  // so faster next time
                            break;
                        }
                    }
                }

                if (!xhr) {
                    throw new Error("createXhr(): XMLHttpRequest not available");
                }

                return xhr;
            },

            get: get,

            /**
             * Parses a resource name into its component parts. Resource names
             * look like: module/name.ext!strip, where the !strip part is
             * optional.
             * @param {String} name the resource name
             * @returns {Object} with properties "moduleName", "ext" and "strip"
             * where strip is a boolean.
             */
            parseName: function (name) {
                var strip = false, index = name.indexOf("."),
                    modName = name.substring(0, index),
                    ext = name.substring(index + 1, name.length);

                index = ext.indexOf("!");
                if (index !== -1) {
                    //Pull off the strip arg.
                    strip = ext.substring(index + 1, ext.length);
                    strip = strip === "strip";
                    ext = ext.substring(0, index);
                }

                return {
                    moduleName: modName,
                    ext: ext,
                    strip: strip
                };
            },

            xdRegExp: /^((\w+)\:)?\/\/([^\/\\]+)/,

            /**
             * Is an URL on another domain. Only works for browser use, returns
             * false in non-browser environments. Only used to know if an
             * optimized .js version of a text resource should be loaded
             * instead.
             * @param {String} url
             * @returns Boolean
             */
            useXhr: function (url, protocol, hostname, port) {
                var match = text.xdRegExp.exec(url),
                    uProtocol, uHostName, uPort;
                if (!match) {
                    return true;
                }
                uProtocol = match[2];
                uHostName = match[3];

                uHostName = uHostName.split(':');
                uPort = uHostName[1];
                uHostName = uHostName[0];

                return (!uProtocol || uProtocol === protocol) &&
                       (!uHostName || uHostName === hostname) &&
                       ((!uPort && !uHostName) || uPort === port);
            },

            finishLoad: function (name, strip, content, onLoad, config) {
                content = strip ? text.strip(content) : content;
                if (config.isBuild) {
                    buildMap[name] = content;
                }
                onLoad(content);
            },

            load: function (name, req, onLoad, config) {
                //Name has format: some.module.filext!strip
                //The strip part is optional.
                //if strip is present, then that means only get the string contents
                //inside a body tag in an HTML string. For XML/SVG content it means
                //removing the <?xml ...?> declarations so the content can be inserted
                //into the current doc without problems.

                // Do not bother with the work if a build and text will
                // not be inlined.
                if (config.isBuild && !config.inlineText) {
                    onLoad();
                    return;
                }

                var parsed = text.parseName(name),
                    nonStripName = parsed.moduleName + '.' + parsed.ext,
                    url = req.toUrl(nonStripName),
                    useXhr = (config && config.text && config.text.useXhr) ||
                             text.useXhr;

                //Load the text. Use XHR if possible and in a browser.
                if (!hasLocation || useXhr(url, defaultProtocol, defaultHostName, defaultPort)) {
                    text.get(url, function (content) {
                        text.finishLoad(name, parsed.strip, content, onLoad, config);
                    });
                } else {
                    //Need to fetch the resource across domains. Assume
                    //the resource has been optimized into a JS module. Fetch
                    //by the module name + extension, but do not include the
                    //!strip part to avoid file system issues.
                    req([nonStripName], function (content) {
                        text.finishLoad(parsed.moduleName + '.' + parsed.ext,
                                        parsed.strip, content, onLoad, config);
                    });
                }
            },

            write: function (pluginName, moduleName, write, config) {
                if (moduleName in buildMap) {
                    var content = text.jsEscape(buildMap[moduleName]);
                    write.asModule(pluginName + "!" + moduleName,
                                   "define(function () { return '" +
                                       content +
                                   "';});\n");
                }
            },

            writeFile: function (pluginName, moduleName, req, write, config) {
                var parsed = text.parseName(moduleName),
                    nonStripName = parsed.moduleName + '.' + parsed.ext,
                    //Use a '.js' file name so that it indicates it is a
                    //script that can be loaded across domains.
                    fileName = req.toUrl(parsed.moduleName + '.' +
                                         parsed.ext) + '.js';

                //Leverage own load() method to load plugin value, but only
                //write out values that do not have the strip argument,
                //to avoid any potential issues with ! in file names.
                text.load(nonStripName, req, function (value) {
                    //Use own write() method to construct full module value.
                    //But need to create shell that translates writeFile's
                    //write() to the right interface.
                    var textWrite = function (contents) {
                        return write(fileName, contents);
                    };
                    textWrite.asModule = function (moduleName, contents) {
                        return write.asModule(moduleName, fileName, contents);
                    };

                    text.write(pluginName, nonStripName, textWrite, config);
                }, config);
            }
        };

        return text;
    });
}());

define('text!acquire/doc.md',[],function () { return '## Usage\n\n    volo.js acquire [flags] archive [localName]\n\nwhere the allowed flags, archive value and localName values are all the same\nas the **add** command.\n\nThis command just delegates to **add** but installs the code in a **volo**\ndirectory that is the sibling of the volo.js file used to run the command.\n\n## Notes\n\nThe user running this command needs to have write access to the directory that\ncontains volo.js so the volo directory can be created and have file installed\ninto it.\n';});

define('text!rejuvenate/doc.md',[],function () { return '## Usage\n\n    volo.js rejuvenate [flags] [archive#path/to/volo.js]\n\nIt will replace volo.js with the most recent version tag of volo.js.\n\nBy default it uses **volojs/volo#dist/volo.js** for the archive, but you\ncan use any archive value that is supported by the **add** command. Just\nbe sure to list the path to volo.js in the archive.\n\nrejuvenate accepts the same flags as the **add** command. It explicitly forces\nthe install via the add commands -f flag.\n\nI you want to live on the edge, then you could use the following command:\n\n    volo.js rejuvenate volojs/volo/master#dist/volo.js\n\n## Notes\n\nThe user running this command needs to have write access to the directory that\ncontains volo.js so the volo directory can be created and have file installed\ninto it.\n';});

define('text!create/doc.md',[],function () { return '## Usage\n\n    volo.js create appName [templateArchive]\n\n**appName** is the name of the directory that should be created containing the\ncontents of the templateArchive.\n\n**templateArchive** defaults to a value of \'volojs/create-template\', but\nany archive value that is usable by **add** can work here instead. The only\nrestriction is that the archive value should resolve to a .tar.gz file and\na #specific/file.js type of archive value should not be used.\n';});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint */
/*global define, console, process */

define('create',['require','exports','module','fs','path','q','volo/tempDir','volo/archive','volo/file','volo/download','volo/tar','volo/volofile','text!./create/doc.md','volo/commands'],function (require, exports, module) {
    var fs = require('fs'),
        path = require('path'),
        q = require('q'),
        tempDir = require('volo/tempDir'),
        archive = require('volo/archive'),
        file = require('volo/file'),
        download = require('volo/download'),
        tar = require('volo/tar'),
        volofile = require('volo/volofile'),
        create;

    create = {
        summary: 'Creates a new web project.',

        doc: require('text!./create/doc.md'),

        validate: function (namedArgs, appName) {
            if (!appName || !(/^[A-Za-z\d\-]+$/.test(appName))) {
                return new Error('appName can only contain alphanumeric and dash characters.');
            } else if (path.existsSync(appName)) {
                return new Error(appName + ' already exists.');
            }
            return undefined;
        },

        run: function (deferred, v, namedArgs, appName, template) {
            template = template || 'volojs/create-template';

            var archiveInfo;

            //Find out how to get the template
            deferred.resolve(q.call(function () {
                return archive.resolve(template, namedArgs.volo.resolve);
            })
            //Create a tempdir to store the archive.
            .then(function (info) {
                archiveInfo = info;
                return tempDir.create(template);
            })
            //Download and unpack the template.
            .then(function (tempDirName) {
                var tarFileName = path.join(tempDirName, 'template.tar.gz'),
                    step;

                //Function used to clean up in case of errors.
                function errCleanUp(err) {
                    file.rmdir(tempDirName);
                    return err;
                }

                //Download
                step = q.call(function () {
                    return download(archiveInfo.url, tarFileName);
                }, errCleanUp);

                //If an archive unpack it.
                if (archiveInfo.isArchive) {
                    step = step.then(function () {
                        return tar.untar(tarFileName);
                    }, errCleanUp);
                }

                //Move the contents to the final destination.
                step = step.then(function () {
                    //Move the untarred directory to the final location.
                    var dirName = file.firstDir(tempDirName);
                    if (dirName) {
                        //Move the unpacked template to appName
                        fs.renameSync(dirName, appName);

                        //Clean up temp area.
                        file.rmdir(tempDirName);

                        return undefined;
                    } else {
                        return errCleanUp(new Error('Unexpected tarball configuration'));
                    }
                }, errCleanUp)

                //If there is a volofile with an onCreate, run it.
                .then(function () {
                    return volofile.run(appName, 'onCreate', namedArgs, appName);
                })
                .then(function (commandOutput) {
                    return (commandOutput ? commandOutput : '') +
                            archiveInfo.url + ' used to create ' + appName;
                });

                return step;
            }));
        }
    };

    return require('volo/commands').register(module.id, create);
});

define('text!add/doc.md',[],function () { return '## Usage\n\n    volo.js add [flags] archive [localName]\n\nwhere the allowed flags are:\n\n* -f: Forces the add even if the code has already been added to the project.\n* -amd: Indicates the project is an AMD project. If the project has a\n  package.json entry for "amd": {} then this flag is not needed.\n* -amdlog: Prints out more details on files converted to AMD, if AMD conversion\n  is done.\n\n**archive** is in one of the following formats:\n\n* user/repo: Download the tar.gz from GitHub for the user/repo, using the latest\n  version tag, or "master" if no version tags.\n* user/repo/tag: Download the tar.gz from GitHub for the user/repo, using the\n  specific tag/branch name listed.\n* user/repo/tag#specific/file.js: Download the tar.gz from GitHub for the user/\n  repo, using the specific tag/branch name listed, then extracting only\n  the specific/file.js from that archive and installing it.\n* http://some.domain.com/path/to/archive.tar.gz: Downloads the tar.gz file and\n  installs it.\n* http://some.domain.com/path/to/archive.tar.gz#specific/file.js: Download\n  the tar.gz file and only install specific/file.js.\n* symlink:path/to/directory/or/file.js: Creates a symlink to the specific\n  location in the project. If it is a directory and the project using the\n  directory is an AMD project, an adapter module will also be created.\n* local:paht/to/directory: Copies the local directory. A local directory is\n  also checked when the "some/thing" archive name is used -- if there is no\n  local file match, it is assumed to be a GitHub URL.\n\nIf **localName** is specified then that name is used for the installed name.\nIf the installed item is a directory, the directory will have this name. If\na specific file from the the archive, the file will have this name.\n\nIf **localName** is not specified, the installed directory name will be the\nname of the .tar.gz file without the tar.gz extension, or if a GitHub\nreference, the repo name. If it is a specific file from within a .tar.gz file,\nthen that file\'s name will be used.\n\n## Examples\n\nThis one fetches Underscore and converts it to have an AMD wrapper. Underscore\nstill registers a global export, but AMD code can get a local reference\nthrough the module ID:\n\n    volo.js add -amd documentcloud/underscore exports=_\n\nWhen the -amd flag is used, the the **amdify** command is used to convert\nthe file downloaded by the **add** command, so the named arguments supported\nby **amdify** can als be used with **add**.\n\nHere is a command that fetches Backbone and wraps in it in an AMD define() call,\nspecifying \'jquery\' and \'underscore\' as dependencies:\n\n    volo.js add -amd documentcloud/backbone depend=underscore,jquery exports=Backbone\n\n\n## Installation Details\n\nFor the directory in which add is run, it will look for the following to know\nwhere to install:\n\n* Looks for a package.json file and if there is an amd.baseUrl defined in it.\n* Looks for a **js** directory\n* Looks for a **scripts** directory\n\nIf none of those result in a subdirectory for installation, then the current\nworking directory is used.\n\nIf the archive has a top level .js file in it and it is the same name\nas the repo\'s/tar.gz file name, then only that .js file will be installed.\n\nOr, if there is only one top level .js file in the repo and it has a\n/*package.json */ comment with JSON inside that comment, it will be used.\n';});

define('text!amdify/template.js',[],function () { return '//Wrapped in an outer function to preserve global this\n(function (root) { define([/*DEPENDENCIES*/], function () { (function () {\n\n/*CONTENTS*/\n\n}.call(root));\n\n/*EXPORTS*/\n}); }(this));\n';});

define('text!amdify/exportsTemplate.js',[],function () { return 'return /*EXPORTS*/;\n';});

define('text!amdify/exportsNoConflictTemplate.js',[],function () { return 'if (/*EXPORTS*/.noConflict) {\n    /*EXPORTS*/.noConflict(true);\n}\nreturn /*EXPORTS*/;\n';});

define('text!amdify/doc.md',[],function () { return '## Usage\n\n    volo.js amdify [-noConflict] path/to/file.js [depends=] [exports=]\n\nwhere:\n\n* depends is a comma-separated list of dependencies, with no spaces\n* exports is the global value created by the file that should be treated as the\n  module\'s exported value.\n* -noConflict indicates that code shoud be included to call the exports\n  value\'s noConflict method if it exists.\n\n## Details\n\nThe file.js will be modified to include a define() wrapper with the given\ndependency names.\n\nThis example:\n\n    volo.js amdify www/js/aplugin.jquery.js depends=jquery\n\nWill result in modifying the www/js/aplugin.jquery.js contents to have a\nfunction wrapping that includes:\n\n    define([\'jquery\'], function () {\n        //original contents in here.\n    });\n\nThis example sets dependencies, but then also specifies the export value to\nbe used. If the export object has a \'noConflict\' method on it, then it will\nbe called as part of exporting the module value:\n\n    volo.js amdify www/js/lib.js depends=jquery exports=lib\n\nresults in a transform that looks roughly like:\n\n    define([\'jquery\'], function () {\n\n        //original contents in here.\n\n        return lib;\n    });\n\nIf you want "-noConflict" called on the exports value:\n\n    volo.js amdify -noConflict www/js/lib.js depends=jquery exports=lib\n\nresults in a transform that looks roughly like:\n\n    define([\'jquery\'], function () {\n\n        //original contents in here.\n\n        if (lib.noConflict)) {\n            lib.noConflict(true);\n        }\n        return lib;\n    });\n\n**Be careful with -noConflict**. You most likely do not want to use it if\nyou have other code that has been amdify\'d that depends on this amdify\'d code.\nFor instance, using amdify on underscore.js with -noConflict is bad since\nbackbone.js depends on underscore, and it looks for a global _ value.\n\namdify will set the "this" value for the original contents to be the global\nobject.\n\nIdeally the target file would optionally call define() itself, and use\nthe local dependency references instead of browser globals. However, for\nbootstrapping existing projects to use an AMD loader, amdify can be useful to\nget started.\n\nUsing amdify will produce code that is uglier than doing a proper code change\nto add optional an optional define() call. For better code examples, see:\nhttps://github.com/umdjs/umd\n';});

define('volo/uglifyjs/squeeze-more',["require", "exports", "module", "./parse-js", "./process"], function(require, exports, module) {

var jsp = require("./parse-js"),
    pro = require("./process"),
    slice = jsp.slice,
    member = jsp.member,
    curry = jsp.curry,
    MAP = pro.MAP,
    PRECEDENCE = jsp.PRECEDENCE,
    OPERATORS = jsp.OPERATORS;

function ast_squeeze_more(ast) {
        var w = pro.ast_walker(), walk = w.walk, scope;
        function with_scope(s, cont) {
                var save = scope, ret;
                scope = s;
                ret = cont();
                scope = save;
                return ret;
        };
        function _lambda(name, args, body) {
                return [ this[0], name, args, with_scope(body.scope, curry(MAP, body, walk)) ];
        };
        return w.with_walkers({
                "toplevel": function(body) {
                        return [ this[0], with_scope(this.scope, curry(MAP, body, walk)) ];
                },
                "function": _lambda,
                "defun": _lambda,
                "new": function(ctor, args) {
                        if (ctor[0] == "name") {
                                if (ctor[1] == "Array" && !scope.has("Array")) {
                                        if (args.length != 1) {
                                                return [ "array", args ];
                                        } else {
                                                return walk([ "call", [ "name", "Array" ], args ]);
                                        }
                                } else if (ctor[1] == "Object" && !scope.has("Object")) {
                                        if (!args.length) {
                                                return [ "object", [] ];
                                        } else {
                                                return walk([ "call", [ "name", "Object" ], args ]);
                                        }
                                } else if ((ctor[1] == "RegExp" || ctor[1] == "Function" || ctor[1] == "Error") && !scope.has(ctor[1])) {
                                        return walk([ "call", [ "name", ctor[1] ], args]);
                                }
                        }
                },
                "call": function(expr, args) {
                        if (expr[0] == "dot" && expr[2] == "toString" && args.length == 0) {
                                // foo.toString()  ==>  foo+""
                                return [ "binary", "+", expr[1], [ "string", "" ]];
                        }
                        if (expr[0] == "name") {
                                if (expr[1] == "Array" && args.length != 1 && !scope.has("Array")) {
                                        return [ "array", args ];
                                }
                                if (expr[1] == "Object" && !args.length && !scope.has("Object")) {
                                        return [ "object", [] ];
                                }
                                if (expr[1] == "String" && !scope.has("String")) {
                                        return [ "binary", "+", args[0], [ "string", "" ]];
                                }
                        }
                }
        }, function() {
                return walk(pro.ast_add_scope(ast));
        });
};

exports.ast_squeeze_more = ast_squeeze_more;

});
define('volo/uglifyjs/process',["require", "exports", "module", "./parse-js", "./squeeze-more"], function(require, exports, module) {

/***********************************************************************

  A JavaScript tokenizer / parser / beautifier / compressor.

  This version is suitable for Node.js.  With minimal changes (the
  exports stuff) it should work on any JS platform.

  This file implements some AST processors.  They work on data built
  by parse-js.

  Exported functions:

    - ast_mangle(ast, options) -- mangles the variable/function names
      in the AST.  Returns an AST.

    - ast_squeeze(ast) -- employs various optimizations to make the
      final generated code even smaller.  Returns an AST.

    - gen_code(ast, options) -- generates JS code from the AST.  Pass
      true (or an object, see the code for some options) as second
      argument to get "pretty" (indented) code.

  -------------------------------- (C) ---------------------------------

                           Author: Mihai Bazon
                         <mihai.bazon@gmail.com>
                       http://mihai.bazon.net/blog

  Distributed under the BSD license:

    Copyright 2010 (c) Mihai Bazon <mihai.bazon@gmail.com>

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions
    are met:

        * Redistributions of source code must retain the above
          copyright notice, this list of conditions and the following
          disclaimer.

        * Redistributions in binary form must reproduce the above
          copyright notice, this list of conditions and the following
          disclaimer in the documentation and/or other materials
          provided with the distribution.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDER “AS IS” AND ANY
    EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
    IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
    PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE
    LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY,
    OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
    PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
    PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
    THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
    TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF
    THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
    SUCH DAMAGE.

 ***********************************************************************/

var jsp = require("./parse-js"),
    slice = jsp.slice,
    member = jsp.member,
    PRECEDENCE = jsp.PRECEDENCE,
    OPERATORS = jsp.OPERATORS;

/* -----[ helper for AST traversal ]----- */

function ast_walker() {
        function _vardefs(defs) {
                return [ this[0], MAP(defs, function(def){
                        var a = [ def[0] ];
                        if (def.length > 1)
                                a[1] = walk(def[1]);
                        return a;
                }) ];
        };
        function _block(statements) {
                var out = [ this[0] ];
                if (statements != null)
                        out.push(MAP(statements, walk));
                return out;
        };
        var walkers = {
                "string": function(str) {
                        return [ this[0], str ];
                },
                "num": function(num) {
                        return [ this[0], num ];
                },
                "name": function(name) {
                        return [ this[0], name ];
                },
                "toplevel": function(statements) {
                        return [ this[0], MAP(statements, walk) ];
                },
                "block": _block,
                "splice": _block,
                "var": _vardefs,
                "const": _vardefs,
                "try": function(t, c, f) {
                        return [
                                this[0],
                                MAP(t, walk),
                                c != null ? [ c[0], MAP(c[1], walk) ] : null,
                                f != null ? MAP(f, walk) : null
                        ];
                },
                "throw": function(expr) {
                        return [ this[0], walk(expr) ];
                },
                "new": function(ctor, args) {
                        return [ this[0], walk(ctor), MAP(args, walk) ];
                },
                "switch": function(expr, body) {
                        return [ this[0], walk(expr), MAP(body, function(branch){
                                return [ branch[0] ? walk(branch[0]) : null,
                                         MAP(branch[1], walk) ];
                        }) ];
                },
                "break": function(label) {
                        return [ this[0], label ];
                },
                "continue": function(label) {
                        return [ this[0], label ];
                },
                "conditional": function(cond, t, e) {
                        return [ this[0], walk(cond), walk(t), walk(e) ];
                },
                "assign": function(op, lvalue, rvalue) {
                        return [ this[0], op, walk(lvalue), walk(rvalue) ];
                },
                "dot": function(expr) {
                        return [ this[0], walk(expr) ].concat(slice(arguments, 1));
                },
                "call": function(expr, args) {
                        return [ this[0], walk(expr), MAP(args, walk) ];
                },
                "function": function(name, args, body) {
                        return [ this[0], name, args.slice(), MAP(body, walk) ];
                },
                "defun": function(name, args, body) {
                        return [ this[0], name, args.slice(), MAP(body, walk) ];
                },
                "if": function(conditional, t, e) {
                        return [ this[0], walk(conditional), walk(t), walk(e) ];
                },
                "for": function(init, cond, step, block) {
                        return [ this[0], walk(init), walk(cond), walk(step), walk(block) ];
                },
                "for-in": function(vvar, key, hash, block) {
                        return [ this[0], walk(vvar), walk(key), walk(hash), walk(block) ];
                },
                "while": function(cond, block) {
                        return [ this[0], walk(cond), walk(block) ];
                },
                "do": function(cond, block) {
                        return [ this[0], walk(cond), walk(block) ];
                },
                "return": function(expr) {
                        return [ this[0], walk(expr) ];
                },
                "binary": function(op, left, right) {
                        return [ this[0], op, walk(left), walk(right) ];
                },
                "unary-prefix": function(op, expr) {
                        return [ this[0], op, walk(expr) ];
                },
                "unary-postfix": function(op, expr) {
                        return [ this[0], op, walk(expr) ];
                },
                "sub": function(expr, subscript) {
                        return [ this[0], walk(expr), walk(subscript) ];
                },
                "object": function(props) {
                        return [ this[0], MAP(props, function(p){
                                return p.length == 2
                                        ? [ p[0], walk(p[1]) ]
                                        : [ p[0], walk(p[1]), p[2] ]; // get/set-ter
                        }) ];
                },
                "regexp": function(rx, mods) {
                        return [ this[0], rx, mods ];
                },
                "array": function(elements) {
                        return [ this[0], MAP(elements, walk) ];
                },
                "stat": function(stat) {
                        return [ this[0], walk(stat) ];
                },
                "seq": function() {
                        return [ this[0] ].concat(MAP(slice(arguments), walk));
                },
                "label": function(name, block) {
                        return [ this[0], name, walk(block) ];
                },
                "with": function(expr, block) {
                        return [ this[0], walk(expr), walk(block) ];
                },
                "atom": function(name) {
                        return [ this[0], name ];
                }
        };

        var user = {};
        var stack = [];
        function walk(ast) {
                if (ast == null)
                        return null;
                try {
                        stack.push(ast);
                        var type = ast[0];
                        var gen = user[type];
                        if (gen) {
                                var ret = gen.apply(ast, ast.slice(1));
                                if (ret != null)
                                        return ret;
                        }
                        gen = walkers[type];
                        return gen.apply(ast, ast.slice(1));
                } finally {
                        stack.pop();
                }
        };

        function dive(ast) {
                if (ast == null)
                        return null;
                try {
                        stack.push(ast);
                        return walkers[ast[0]].apply(ast, ast.slice(1));
                } finally {
                        stack.pop();
                }
        };

        function with_walkers(walkers, cont){
                var save = {}, i;
                for (i in walkers) if (HOP(walkers, i)) {
                        save[i] = user[i];
                        user[i] = walkers[i];
                }
                var ret = cont();
                for (i in save) if (HOP(save, i)) {
                        if (!save[i]) delete user[i];
                        else user[i] = save[i];
                }
                return ret;
        };

        return {
                walk: walk,
                dive: dive,
                with_walkers: with_walkers,
                parent: function() {
                        return stack[stack.length - 2]; // last one is current node
                },
                stack: function() {
                        return stack;
                }
        };
};

/* -----[ Scope and mangling ]----- */

function Scope(parent) {
        this.names = {};        // names defined in this scope
        this.mangled = {};      // mangled names (orig.name => mangled)
        this.rev_mangled = {};  // reverse lookup (mangled => orig.name)
        this.cname = -1;        // current mangled name
        this.refs = {};         // names referenced from this scope
        this.uses_with = false; // will become TRUE if with() is detected in this or any subscopes
        this.uses_eval = false; // will become TRUE if eval() is detected in this or any subscopes
        this.parent = parent;   // parent scope
        this.children = [];     // sub-scopes
        if (parent) {
                this.level = parent.level + 1;
                parent.children.push(this);
        } else {
                this.level = 0;
        }
};

var base54 = (function(){
        var DIGITS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$_";
        return function(num) {
                var ret = "";
                do {
                        ret = DIGITS.charAt(num % 54) + ret;
                        num = Math.floor(num / 54);
                } while (num > 0);
                return ret;
        };
})();

Scope.prototype = {
        has: function(name) {
                for (var s = this; s; s = s.parent)
                        if (HOP(s.names, name))
                                return s;
        },
        has_mangled: function(mname) {
                for (var s = this; s; s = s.parent)
                        if (HOP(s.rev_mangled, mname))
                                return s;
        },
        toJSON: function() {
                return {
                        names: this.names,
                        uses_eval: this.uses_eval,
                        uses_with: this.uses_with
                };
        },

        next_mangled: function() {
                // we must be careful that the new mangled name:
                //
                // 1. doesn't shadow a mangled name from a parent
                //    scope, unless we don't reference the original
                //    name from this scope OR from any sub-scopes!
                //    This will get slow.
                //
                // 2. doesn't shadow an original name from a parent
                //    scope, in the event that the name is not mangled
                //    in the parent scope and we reference that name
                //    here OR IN ANY SUBSCOPES!
                //
                // 3. doesn't shadow a name that is referenced but not
                //    defined (possibly global defined elsewhere).
                for (;;) {
                        var m = base54(++this.cname), prior;

                        // case 1.
                        prior = this.has_mangled(m);
                        if (prior && this.refs[prior.rev_mangled[m]] === prior)
                                continue;

                        // case 2.
                        prior = this.has(m);
                        if (prior && prior !== this && this.refs[m] === prior && !prior.has_mangled(m))
                                continue;

                        // case 3.
                        if (HOP(this.refs, m) && this.refs[m] == null)
                                continue;

                        // I got "do" once. :-/
                        if (!is_identifier(m))
                                continue;

                        return m;
                }
        },
        set_mangle: function(name, m) {
                this.rev_mangled[m] = name;
                return this.mangled[name] = m;
        },
        get_mangled: function(name, newMangle) {
                if (this.uses_eval || this.uses_with) return name; // no mangle if eval or with is in use
                var s = this.has(name);
                if (!s) return name; // not in visible scope, no mangle
                if (HOP(s.mangled, name)) return s.mangled[name]; // already mangled in this scope
                if (!newMangle) return name;                      // not found and no mangling requested
                return s.set_mangle(name, s.next_mangled());
        },
        references: function(name) {
                return name && !this.parent || this.uses_with || this.uses_eval || this.refs[name];
        },
        define: function(name, type) {
                if (name != null) {
                        if (type == "var" || !HOP(this.names, name))
                                this.names[name] = type || "var";
                        return name;
                }
        }
};

function ast_add_scope(ast) {

        var current_scope = null;
        var w = ast_walker(), walk = w.walk;
        var having_eval = [];

        function with_new_scope(cont) {
                current_scope = new Scope(current_scope);
                current_scope.labels = new Scope();
                var ret = current_scope.body = cont();
                ret.scope = current_scope;
                current_scope = current_scope.parent;
                return ret;
        };

        function define(name, type) {
                return current_scope.define(name, type);
        };

        function reference(name) {
                current_scope.refs[name] = true;
        };

        function _lambda(name, args, body) {
                var is_defun = this[0] == "defun";
                return [ this[0], is_defun ? define(name, "defun") : name, args, with_new_scope(function(){
                        if (!is_defun) define(name, "lambda");
                        MAP(args, function(name){ define(name, "arg") });
                        return MAP(body, walk);
                })];
        };

        function _vardefs(type) {
                return function(defs) {
                        MAP(defs, function(d){
                                define(d[0], type);
                                if (d[1]) reference(d[0]);
                        });
                };
        };

        function _breacont(label) {
                if (label)
                        current_scope.labels.refs[label] = true;
        };

        return with_new_scope(function(){
                // process AST
                var ret = w.with_walkers({
                        "function": _lambda,
                        "defun": _lambda,
                        "label": function(name, stat) { current_scope.labels.define(name) },
                        "break": _breacont,
                        "continue": _breacont,
                        "with": function(expr, block) {
                                for (var s = current_scope; s; s = s.parent)
                                        s.uses_with = true;
                        },
                        "var": _vardefs("var"),
                        "const": _vardefs("const"),
                        "try": function(t, c, f) {
                                if (c != null) return [
                                        this[0],
                                        MAP(t, walk),
                                        [ define(c[0], "catch"), MAP(c[1], walk) ],
                                        f != null ? MAP(f, walk) : null
                                ];
                        },
                        "name": function(name) {
                                if (name == "eval")
                                        having_eval.push(current_scope);
                                reference(name);
                        }
                }, function(){
                        return walk(ast);
                });

                // the reason why we need an additional pass here is
                // that names can be used prior to their definition.

                // scopes where eval was detected and their parents
                // are marked with uses_eval, unless they define the
                // "eval" name.
                MAP(having_eval, function(scope){
                        if (!scope.has("eval")) while (scope) {
                                scope.uses_eval = true;
                                scope = scope.parent;
                        }
                });

                // for referenced names it might be useful to know
                // their origin scope.  current_scope here is the
                // toplevel one.
                function fixrefs(scope, i) {
                        // do children first; order shouldn't matter
                        for (i = scope.children.length; --i >= 0;)
                                fixrefs(scope.children[i]);
                        for (i in scope.refs) if (HOP(scope.refs, i)) {
                                // find origin scope and propagate the reference to origin
                                for (var origin = scope.has(i), s = scope; s; s = s.parent) {
                                        s.refs[i] = origin;
                                        if (s === origin) break;
                                }
                        }
                };
                fixrefs(current_scope);

                return ret;
        });

};

/* -----[ mangle names ]----- */

function ast_mangle(ast, options) {
        var w = ast_walker(), walk = w.walk, scope;
        options = options || {};

        function get_mangled(name, newMangle) {
                if (!options.toplevel && !scope.parent) return name; // don't mangle toplevel
                if (options.except && member(name, options.except))
                        return name;
                return scope.get_mangled(name, newMangle);
        };

        function get_define(name) {
                if (options.defines) {
                        // we always lookup a defined symbol for the current scope FIRST, so declared
                        // vars trump a DEFINE symbol, but if no such var is found, then match a DEFINE value
                        if (!scope.has(name)) {
                                if (HOP(options.defines, name)) {
                                        return options.defines[name];
                                }
                        }
                        return null;
                }
        };

        function _lambda(name, args, body) {
                if (!options.no_functions) {
                        var is_defun = this[0] == "defun", extra;
                        if (name) {
                                if (is_defun) name = get_mangled(name);
                                else if (body.scope.references(name)) {
                                        extra = {};
                                        if (!(scope.uses_eval || scope.uses_with))
                                                name = extra[name] = scope.next_mangled();
                                        else
                                                extra[name] = name;
                                }
                                else name = null;
                        }
                }
                body = with_scope(body.scope, function(){
                        args = MAP(args, function(name){ return get_mangled(name) });
                        return MAP(body, walk);
                }, extra);
                return [ this[0], name, args, body ];
        };

        function with_scope(s, cont, extra) {
                var _scope = scope;
                scope = s;
                if (extra) for (var i in extra) if (HOP(extra, i)) {
                        s.set_mangle(i, extra[i]);
                }
                for (var i in s.names) if (HOP(s.names, i)) {
                        get_mangled(i, true);
                }
                var ret = cont();
                ret.scope = s;
                scope = _scope;
                return ret;
        };

        function _vardefs(defs) {
                return [ this[0], MAP(defs, function(d){
                        return [ get_mangled(d[0]), walk(d[1]) ];
                }) ];
        };

        function _breacont(label) {
                if (label) return [ this[0], scope.labels.get_mangled(label) ];
        };

        return w.with_walkers({
                "function": _lambda,
                "defun": function() {
                        // move function declarations to the top when
                        // they are not in some block.
                        var ast = _lambda.apply(this, arguments);
                        switch (w.parent()[0]) {
                            case "toplevel":
                            case "function":
                            case "defun":
                                return MAP.at_top(ast);
                        }
                        return ast;
                },
                "label": function(label, stat) {
                        if (scope.labels.refs[label]) return [
                                this[0],
                                scope.labels.get_mangled(label, true),
                                walk(stat)
                        ];
                        return walk(stat);
                },
                "break": _breacont,
                "continue": _breacont,
                "var": _vardefs,
                "const": _vardefs,
                "name": function(name) {
                        return get_define(name) || [ this[0], get_mangled(name) ];
                },
                "try": function(t, c, f) {
                        return [ this[0],
                                 MAP(t, walk),
                                 c != null ? [ get_mangled(c[0]), MAP(c[1], walk) ] : null,
                                 f != null ? MAP(f, walk) : null ];
                },
                "toplevel": function(body) {
                        var self = this;
                        return with_scope(self.scope, function(){
                                return [ self[0], MAP(body, walk) ];
                        });
                }
        }, function() {
                return walk(ast_add_scope(ast));
        });
};

/* -----[
   - compress foo["bar"] into foo.bar,
   - remove block brackets {} where possible
   - join consecutive var declarations
   - various optimizations for IFs:
     - if (cond) foo(); else bar();  ==>  cond?foo():bar();
     - if (cond) foo();  ==>  cond&&foo();
     - if (foo) return bar(); else return baz();  ==> return foo?bar():baz(); // also for throw
     - if (foo) return bar(); else something();  ==> {if(foo)return bar();something()}
   ]----- */

var warn = function(){};

function best_of(ast1, ast2) {
        return gen_code(ast1).length > gen_code(ast2[0] == "stat" ? ast2[1] : ast2).length ? ast2 : ast1;
};

function last_stat(b) {
        if (b[0] == "block" && b[1] && b[1].length > 0)
                return b[1][b[1].length - 1];
        return b;
}

function aborts(t) {
        if (t) switch (last_stat(t)[0]) {
            case "return":
            case "break":
            case "continue":
            case "throw":
                return true;
        }
};

function boolean_expr(expr) {
        return ( (expr[0] == "unary-prefix"
                  && member(expr[1], [ "!", "delete" ])) ||

                 (expr[0] == "binary"
                  && member(expr[1], [ "in", "instanceof", "==", "!=", "===", "!==", "<", "<=", ">=", ">" ])) ||

                 (expr[0] == "binary"
                  && member(expr[1], [ "&&", "||" ])
                  && boolean_expr(expr[2])
                  && boolean_expr(expr[3])) ||

                 (expr[0] == "conditional"
                  && boolean_expr(expr[2])
                  && boolean_expr(expr[3])) ||

                 (expr[0] == "assign"
                  && expr[1] === true
                  && boolean_expr(expr[3])) ||

                 (expr[0] == "seq"
                  && boolean_expr(expr[expr.length - 1]))
               );
};

function empty(b) {
        return !b || (b[0] == "block" && (!b[1] || b[1].length == 0));
};

function is_string(node) {
        return (node[0] == "string" ||
                node[0] == "unary-prefix" && node[1] == "typeof" ||
                node[0] == "binary" && node[1] == "+" &&
                (is_string(node[2]) || is_string(node[3])));
};

var when_constant = (function(){

        var $NOT_CONSTANT = {};

        // this can only evaluate constant expressions.  If it finds anything
        // not constant, it throws $NOT_CONSTANT.
        function evaluate(expr) {
                switch (expr[0]) {
                    case "string":
                    case "num":
                        return expr[1];
                    case "name":
                    case "atom":
                        switch (expr[1]) {
                            case "true": return true;
                            case "false": return false;
                            case "null": return null;
                        }
                        break;
                    case "unary-prefix":
                        switch (expr[1]) {
                            case "!": return !evaluate(expr[2]);
                            case "typeof": return typeof evaluate(expr[2]);
                            case "~": return ~evaluate(expr[2]);
                            case "-": return -evaluate(expr[2]);
                            case "+": return +evaluate(expr[2]);
                        }
                        break;
                    case "binary":
                        var left = expr[2], right = expr[3];
                        switch (expr[1]) {
                            case "&&"         : return evaluate(left) &&         evaluate(right);
                            case "||"         : return evaluate(left) ||         evaluate(right);
                            case "|"          : return evaluate(left) |          evaluate(right);
                            case "&"          : return evaluate(left) &          evaluate(right);
                            case "^"          : return evaluate(left) ^          evaluate(right);
                            case "+"          : return evaluate(left) +          evaluate(right);
                            case "*"          : return evaluate(left) *          evaluate(right);
                            case "/"          : return evaluate(left) /          evaluate(right);
                            case "%"          : return evaluate(left) %          evaluate(right);
                            case "-"          : return evaluate(left) -          evaluate(right);
                            case "<<"         : return evaluate(left) <<         evaluate(right);
                            case ">>"         : return evaluate(left) >>         evaluate(right);
                            case ">>>"        : return evaluate(left) >>>        evaluate(right);
                            case "=="         : return evaluate(left) ==         evaluate(right);
                            case "==="        : return evaluate(left) ===        evaluate(right);
                            case "!="         : return evaluate(left) !=         evaluate(right);
                            case "!=="        : return evaluate(left) !==        evaluate(right);
                            case "<"          : return evaluate(left) <          evaluate(right);
                            case "<="         : return evaluate(left) <=         evaluate(right);
                            case ">"          : return evaluate(left) >          evaluate(right);
                            case ">="         : return evaluate(left) >=         evaluate(right);
                            case "in"         : return evaluate(left) in         evaluate(right);
                            case "instanceof" : return evaluate(left) instanceof evaluate(right);
                        }
                }
                throw $NOT_CONSTANT;
        };

        return function(expr, yes, no) {
                try {
                        var val = evaluate(expr), ast;
                        switch (typeof val) {
                            case "string": ast =  [ "string", val ]; break;
                            case "number": ast =  [ "num", val ]; break;
                            case "boolean": ast =  [ "name", String(val) ]; break;
                            default: throw new Error("Can't handle constant of type: " + (typeof val));
                        }
                        return yes.call(expr, ast, val);
                } catch(ex) {
                        if (ex === $NOT_CONSTANT) {
                                if (expr[0] == "binary"
                                    && (expr[1] == "===" || expr[1] == "!==")
                                    && ((is_string(expr[2]) && is_string(expr[3]))
                                        || (boolean_expr(expr[2]) && boolean_expr(expr[3])))) {
                                        expr[1] = expr[1].substr(0, 2);
                                }
                                else if (no && expr[0] == "binary"
                                         && (expr[1] == "||" || expr[1] == "&&")) {
                                    // the whole expression is not constant but the lval may be...
                                    try {
                                        var lval = evaluate(expr[2]);
                                        expr = ((expr[1] == "&&" && (lval ? expr[3] : lval))    ||
                                                (expr[1] == "||" && (lval ? lval    : expr[3])) ||
                                                expr);
                                    } catch(ex2) {
                                        // IGNORE... lval is not constant
                                    }
                                }
                                return no ? no.call(expr, expr) : null;
                        }
                        else throw ex;
                }
        };

})();

function warn_unreachable(ast) {
        if (!empty(ast))
                warn("Dropping unreachable code: " + gen_code(ast, true));
};

function prepare_ifs(ast) {
        var w = ast_walker(), walk = w.walk;
        // In this first pass, we rewrite ifs which abort with no else with an
        // if-else.  For example:
        //
        // if (x) {
        //     blah();
        //     return y;
        // }
        // foobar();
        //
        // is rewritten into:
        //
        // if (x) {
        //     blah();
        //     return y;
        // } else {
        //     foobar();
        // }
        function redo_if(statements) {
                statements = MAP(statements, walk);

                for (var i = 0; i < statements.length; ++i) {
                        var fi = statements[i];
                        if (fi[0] != "if") continue;

                        if (fi[3] && walk(fi[3])) continue;

                        var t = walk(fi[2]);
                        if (!aborts(t)) continue;

                        var conditional = walk(fi[1]);

                        var e_body = statements.slice(i + 1);
                        var e = e_body.length == 1 ? e_body[0] : [ "block", e_body ];

                        var ret = statements.slice(0, i).concat([ [
                                fi[0],          // "if"
                                conditional,    // conditional
                                t,              // then
                                e               // else
                        ] ]);

                        return redo_if(ret);
                }

                return statements;
        };

        function redo_if_lambda(name, args, body) {
                body = redo_if(body);
                return [ this[0], name, args, body ];
        };

        function redo_if_block(statements) {
                return [ this[0], statements != null ? redo_if(statements) : null ];
        };

        return w.with_walkers({
                "defun": redo_if_lambda,
                "function": redo_if_lambda,
                "block": redo_if_block,
                "splice": redo_if_block,
                "toplevel": function(statements) {
                        return [ this[0], redo_if(statements) ];
                },
                "try": function(t, c, f) {
                        return [
                                this[0],
                                redo_if(t),
                                c != null ? [ c[0], redo_if(c[1]) ] : null,
                                f != null ? redo_if(f) : null
                        ];
                }
        }, function() {
                return walk(ast);
        });
};

function for_side_effects(ast, handler) {
        var w = ast_walker(), walk = w.walk;
        var $stop = {}, $restart = {};
        function stop() { throw $stop };
        function restart() { throw $restart };
        function found(){ return handler.call(this, this, w, stop, restart) };
        function unary(op) {
                if (op == "++" || op == "--")
                        return found.apply(this, arguments);
        };
        return w.with_walkers({
                "try": found,
                "throw": found,
                "return": found,
                "new": found,
                "switch": found,
                "break": found,
                "continue": found,
                "assign": found,
                "call": found,
                "if": found,
                "for": found,
                "for-in": found,
                "while": found,
                "do": found,
                "return": found,
                "unary-prefix": unary,
                "unary-postfix": unary,
                "defun": found
        }, function(){
                while (true) try {
                        walk(ast);
                        break;
                } catch(ex) {
                        if (ex === $stop) break;
                        if (ex === $restart) continue;
                        throw ex;
                }
        });
};

function ast_lift_variables(ast) {
        var w = ast_walker(), walk = w.walk, scope;
        function do_body(body, env) {
                var _scope = scope;
                scope = env;
                body = MAP(body, walk);
                var hash = {}, names = MAP(env.names, function(type, name){
                        if (type != "var") return MAP.skip;
                        if (!env.references(name)) return MAP.skip;
                        hash[name] = true;
                        return [ name ];
                });
                if (names.length > 0) {
                        // looking for assignments to any of these variables.
                        // we can save considerable space by moving the definitions
                        // in the var declaration.
                        for_side_effects([ "block", body ], function(ast, walker, stop, restart) {
                                if (ast[0] == "assign"
                                    && ast[1] === true
                                    && ast[2][0] == "name"
                                    && HOP(hash, ast[2][1])) {
                                        // insert the definition into the var declaration
                                        for (var i = names.length; --i >= 0;) {
                                                if (names[i][0] == ast[2][1]) {
                                                        if (names[i][1]) // this name already defined, we must stop
                                                                stop();
                                                        names[i][1] = ast[3]; // definition
                                                        names.push(names.splice(i, 1)[0]);
                                                        break;
                                                }
                                        }
                                        // remove this assignment from the AST.
                                        var p = walker.parent();
                                        if (p[0] == "seq") {
                                                var a = p[2];
                                                a.unshift(0, p.length);
                                                p.splice.apply(p, a);
                                        }
                                        else if (p[0] == "stat") {
                                                p.splice(0, p.length, "block"); // empty statement
                                        }
                                        else {
                                                stop();
                                        }
                                        restart();
                                }
                                stop();
                        });
                        body.unshift([ "var", names ]);
                }
                scope = _scope;
                return body;
        };
        function _vardefs(defs) {
                var ret = null;
                for (var i = defs.length; --i >= 0;) {
                        var d = defs[i];
                        if (!d[1]) continue;
                        d = [ "assign", true, [ "name", d[0] ], d[1] ];
                        if (ret == null) ret = d;
                        else ret = [ "seq", d, ret ];
                }
                if (ret == null) {
                        if (w.parent()[0] == "for-in")
                                return [ "name", defs[0][0] ];
                        return MAP.skip;
                }
                return [ "stat", ret ];
        };
        function _toplevel(body) {
                return [ this[0], do_body(body, this.scope) ];
        };
        return w.with_walkers({
                "function": function(name, args, body){
                        for (var i = args.length; --i >= 0 && !body.scope.references(args[i]);)
                                args.pop();
                        if (!body.scope.references(name)) name = null;
                        return [ this[0], name, args, do_body(body, body.scope) ];
                },
                "defun": function(name, args, body){
                        if (!scope.references(name)) return MAP.skip;
                        for (var i = args.length; --i >= 0 && !body.scope.references(args[i]);)
                                args.pop();
                        return [ this[0], name, args, do_body(body, body.scope) ];
                },
                "var": _vardefs,
                "toplevel": _toplevel
        }, function(){
                return walk(ast_add_scope(ast));
        });
};

function ast_squeeze(ast, options) {
        options = defaults(options, {
                make_seqs   : true,
                dead_code   : true,
                no_warnings : false,
                keep_comps  : true
        });

        var w = ast_walker(), walk = w.walk;

        function negate(c) {
                var not_c = [ "unary-prefix", "!", c ];
                switch (c[0]) {
                    case "unary-prefix":
                        return c[1] == "!" && boolean_expr(c[2]) ? c[2] : not_c;
                    case "seq":
                        c = slice(c);
                        c[c.length - 1] = negate(c[c.length - 1]);
                        return c;
                    case "conditional":
                        return best_of(not_c, [ "conditional", c[1], negate(c[2]), negate(c[3]) ]);
                    case "binary":
                        var op = c[1], left = c[2], right = c[3];
                        if (!options.keep_comps) switch (op) {
                            case "<="  : return [ "binary", ">", left, right ];
                            case "<"   : return [ "binary", ">=", left, right ];
                            case ">="  : return [ "binary", "<", left, right ];
                            case ">"   : return [ "binary", "<=", left, right ];
                        }
                        switch (op) {
                            case "=="  : return [ "binary", "!=", left, right ];
                            case "!="  : return [ "binary", "==", left, right ];
                            case "===" : return [ "binary", "!==", left, right ];
                            case "!==" : return [ "binary", "===", left, right ];
                            case "&&"  : return best_of(not_c, [ "binary", "||", negate(left), negate(right) ]);
                            case "||"  : return best_of(not_c, [ "binary", "&&", negate(left), negate(right) ]);
                        }
                        break;
                }
                return not_c;
        };

        function make_conditional(c, t, e) {
                var make_real_conditional = function() {
                        if (c[0] == "unary-prefix" && c[1] == "!") {
                                return e ? [ "conditional", c[2], e, t ] : [ "binary", "||", c[2], t ];
                        } else {
                                return e ? best_of(
                                        [ "conditional", c, t, e ],
                                        [ "conditional", negate(c), e, t ]
                                ) : [ "binary", "&&", c, t ];
                        }
                };
                // shortcut the conditional if the expression has a constant value
                return when_constant(c, function(ast, val){
                        warn_unreachable(val ? e : t);
                        return          (val ? t : e);
                }, make_real_conditional);
        };

        function rmblock(block) {
                if (block != null && block[0] == "block" && block[1]) {
                        if (block[1].length == 1)
                                block = block[1][0];
                        else if (block[1].length == 0)
                                block = [ "block" ];
                }
                return block;
        };

        function _lambda(name, args, body) {
                return [ this[0], name, args, tighten(body, "lambda") ];
        };

        // this function does a few things:
        // 1. discard useless blocks
        // 2. join consecutive var declarations
        // 3. remove obviously dead code
        // 4. transform consecutive statements using the comma operator
        // 5. if block_type == "lambda" and it detects constructs like if(foo) return ... - rewrite like if (!foo) { ... }
        function tighten(statements, block_type) {
                statements = MAP(statements, walk);

                statements = statements.reduce(function(a, stat){
                        if (stat[0] == "block") {
                                if (stat[1]) {
                                        a.push.apply(a, stat[1]);
                                }
                        } else {
                                a.push(stat);
                        }
                        return a;
                }, []);

                statements = (function(a, prev){
                        statements.forEach(function(cur){
                                if (prev && ((cur[0] == "var" && prev[0] == "var") ||
                                             (cur[0] == "const" && prev[0] == "const"))) {
                                        prev[1] = prev[1].concat(cur[1]);
                                } else {
                                        a.push(cur);
                                        prev = cur;
                                }
                        });
                        return a;
                })([]);

                if (options.dead_code) statements = (function(a, has_quit){
                        statements.forEach(function(st){
                                if (has_quit) {
                                        if (st[0] == "function" || st[0] == "defun") {
                                                a.push(st);
                                        }
                                        else if (st[0] == "var" || st[0] == "const") {
                                                if (!options.no_warnings)
                                                        warn("Variables declared in unreachable code");
                                                st[1] = MAP(st[1], function(def){
                                                        if (def[1] && !options.no_warnings)
                                                                warn_unreachable([ "assign", true, [ "name", def[0] ], def[1] ]);
                                                        return [ def[0] ];
                                                });
                                                a.push(st);
                                        }
                                        else if (!options.no_warnings)
                                                warn_unreachable(st);
                                }
                                else {
                                        a.push(st);
                                        if (member(st[0], [ "return", "throw", "break", "continue" ]))
                                                has_quit = true;
                                }
                        });
                        return a;
                })([]);

                if (options.make_seqs) statements = (function(a, prev) {
                        statements.forEach(function(cur){
                                if (prev && prev[0] == "stat" && cur[0] == "stat") {
                                        prev[1] = [ "seq", prev[1], cur[1] ];
                                } else {
                                        a.push(cur);
                                        prev = cur;
                                }
                        });
                        if (a.length >= 2
                            && a[a.length-2][0] == "stat"
                            && (a[a.length-1][0] == "return" || a[a.length-1][0] == "throw")
                            && a[a.length-1][1])
                        {
                                a.splice(a.length - 2, 2,
                                         [ a[a.length-1][0],
                                           [ "seq", a[a.length-2][1], a[a.length-1][1] ]]);
                        }
                        return a;
                })([]);

                // this increases jQuery by 1K.  Probably not such a good idea after all..
                // part of this is done in prepare_ifs anyway.
                // if (block_type == "lambda") statements = (function(i, a, stat){
                //         while (i < statements.length) {
                //                 stat = statements[i++];
                //                 if (stat[0] == "if" && !stat[3]) {
                //                         if (stat[2][0] == "return" && stat[2][1] == null) {
                //                                 a.push(make_if(negate(stat[1]), [ "block", statements.slice(i) ]));
                //                                 break;
                //                         }
                //                         var last = last_stat(stat[2]);
                //                         if (last[0] == "return" && last[1] == null) {
                //                                 a.push(make_if(stat[1], [ "block", stat[2][1].slice(0, -1) ], [ "block", statements.slice(i) ]));
                //                                 break;
                //                         }
                //                 }
                //                 a.push(stat);
                //         }
                //         return a;
                // })(0, []);

                return statements;
        };

        function make_if(c, t, e) {
                return when_constant(c, function(ast, val){
                        if (val) {
                                t = walk(t);
                                warn_unreachable(e);
                                return t || [ "block" ];
                        } else {
                                e = walk(e);
                                warn_unreachable(t);
                                return e || [ "block" ];
                        }
                }, function() {
                        return make_real_if(c, t, e);
                });
        };

        function make_real_if(c, t, e) {
                c = walk(c);
                t = walk(t);
                e = walk(e);

                if (empty(t)) {
                        c = negate(c);
                        t = e;
                        e = null;
                } else if (empty(e)) {
                        e = null;
                } else {
                        // if we have both else and then, maybe it makes sense to switch them?
                        (function(){
                                var a = gen_code(c);
                                var n = negate(c);
                                var b = gen_code(n);
                                if (b.length < a.length) {
                                        var tmp = t;
                                        t = e;
                                        e = tmp;
                                        c = n;
                                }
                        })();
                }
                if (empty(e) && empty(t))
                        return [ "stat", c ];
                var ret = [ "if", c, t, e ];
                if (t[0] == "if" && empty(t[3]) && empty(e)) {
                        ret = best_of(ret, walk([ "if", [ "binary", "&&", c, t[1] ], t[2] ]));
                }
                else if (t[0] == "stat") {
                        if (e) {
                                if (e[0] == "stat") {
                                        ret = best_of(ret, [ "stat", make_conditional(c, t[1], e[1]) ]);
                                }
                        }
                        else {
                                ret = best_of(ret, [ "stat", make_conditional(c, t[1]) ]);
                        }
                }
                else if (e && t[0] == e[0] && (t[0] == "return" || t[0] == "throw") && t[1] && e[1]) {
                        ret = best_of(ret, [ t[0], make_conditional(c, t[1], e[1] ) ]);
                }
                else if (e && aborts(t)) {
                        ret = [ [ "if", c, t ] ];
                        if (e[0] == "block") {
                                if (e[1]) ret = ret.concat(e[1]);
                        }
                        else {
                                ret.push(e);
                        }
                        ret = walk([ "block", ret ]);
                }
                else if (t && aborts(e)) {
                        ret = [ [ "if", negate(c), e ] ];
                        if (t[0] == "block") {
                                if (t[1]) ret = ret.concat(t[1]);
                        } else {
                                ret.push(t);
                        }
                        ret = walk([ "block", ret ]);
                }
                return ret;
        };

        function _do_while(cond, body) {
                return when_constant(cond, function(cond, val){
                        if (!val) {
                                warn_unreachable(body);
                                return [ "block" ];
                        } else {
                                return [ "for", null, null, null, walk(body) ];
                        }
                });
        };

        return w.with_walkers({
                "sub": function(expr, subscript) {
                        if (subscript[0] == "string") {
                                var name = subscript[1];
                                if (is_identifier(name))
                                        return [ "dot", walk(expr), name ];
                                else if (/^[1-9][0-9]*$/.test(name) || name === "0")
                                        return [ "sub", walk(expr), [ "num", parseInt(name, 10) ] ];
                        }
                },
                "if": make_if,
                "toplevel": function(body) {
                        return [ "toplevel", tighten(body) ];
                },
                "switch": function(expr, body) {
                        var last = body.length - 1;
                        return [ "switch", walk(expr), MAP(body, function(branch, i){
                                var block = tighten(branch[1]);
                                if (i == last && block.length > 0) {
                                        var node = block[block.length - 1];
                                        if (node[0] == "break" && !node[1])
                                                block.pop();
                                }
                                return [ branch[0] ? walk(branch[0]) : null, block ];
                        }) ];
                },
                "function": _lambda,
                "defun": _lambda,
                "block": function(body) {
                        if (body) return rmblock([ "block", tighten(body) ]);
                },
                "binary": function(op, left, right) {
                        return when_constant([ "binary", op, walk(left), walk(right) ], function yes(c){
                                return best_of(walk(c), this);
                        }, function no() {
                                return function(){
                                        if(op != "==" && op != "!=") return;
                                        var l = walk(left), r = walk(right);
                                        if(l && l[0] == "unary-prefix" && l[1] == "!" && l[2][0] == "num")
                                                left = ['num', +!l[2][1]];
                                        else if (r && r[0] == "unary-prefix" && r[1] == "!" && r[2][0] == "num")
                                                right = ['num', +!r[2][1]];
                                        return ["binary", op, left, right];
                                }() || this;
                        });
                },
                "conditional": function(c, t, e) {
                        return make_conditional(walk(c), walk(t), walk(e));
                },
                "try": function(t, c, f) {
                        return [
                                "try",
                                tighten(t),
                                c != null ? [ c[0], tighten(c[1]) ] : null,
                                f != null ? tighten(f) : null
                        ];
                },
                "unary-prefix": function(op, expr) {
                        expr = walk(expr);
                        var ret = [ "unary-prefix", op, expr ];
                        if (op == "!")
                                ret = best_of(ret, negate(expr));
                        return when_constant(ret, function(ast, val){
                                return walk(ast); // it's either true or false, so minifies to !0 or !1
                        }, function() { return ret });
                },
                "name": function(name) {
                        switch (name) {
                            case "true": return [ "unary-prefix", "!", [ "num", 0 ]];
                            case "false": return [ "unary-prefix", "!", [ "num", 1 ]];
                        }
                },
                "while": _do_while,
                "assign": function(op, lvalue, rvalue) {
                        lvalue = walk(lvalue);
                        rvalue = walk(rvalue);
                        var okOps = [ '+', '-', '/', '*', '%', '>>', '<<', '>>>', '|', '^', '&' ];
                        if (op === true && lvalue[0] === "name" && rvalue[0] === "binary" &&
                            ~okOps.indexOf(rvalue[1]) && rvalue[2][0] === "name" &&
                            rvalue[2][1] === lvalue[1]) {
                                return [ this[0], rvalue[1], lvalue, rvalue[3] ]
                        }
                        return [ this[0], op, lvalue, rvalue ];
                }
        }, function() {
                for (var i = 0; i < 2; ++i) {
                        ast = prepare_ifs(ast);
                        ast = walk(ast);
                }
                return ast;
        });
};

/* -----[ re-generate code from the AST ]----- */

var DOT_CALL_NO_PARENS = jsp.array_to_hash([
        "name",
        "array",
        "object",
        "string",
        "dot",
        "sub",
        "call",
        "regexp",
        "defun"
]);

function make_string(str, ascii_only) {
        var dq = 0, sq = 0;
        str = str.replace(/[\\\b\f\n\r\t\x22\x27\u2028\u2029\0]/g, function(s){
                switch (s) {
                    case "\\": return "\\\\";
                    case "\b": return "\\b";
                    case "\f": return "\\f";
                    case "\n": return "\\n";
                    case "\r": return "\\r";
                    case "\t": return "\\t";
                    case "\u2028": return "\\u2028";
                    case "\u2029": return "\\u2029";
                    case '"': ++dq; return '"';
                    case "'": ++sq; return "'";
                    case "\0": return "\\0";
                }
                return s;
        });
        if (ascii_only) str = to_ascii(str);
        if (dq > sq) return "'" + str.replace(/\x27/g, "\\'") + "'";
        else return '"' + str.replace(/\x22/g, '\\"') + '"';
};

function to_ascii(str) {
        return str.replace(/[\u0080-\uffff]/g, function(ch) {
                var code = ch.charCodeAt(0).toString(16);
                while (code.length < 4) code = "0" + code;
                return "\\u" + code;
        });
};

var SPLICE_NEEDS_BRACKETS = jsp.array_to_hash([ "if", "while", "do", "for", "for-in", "with" ]);

function gen_code(ast, options) {
        options = defaults(options, {
                indent_start : 0,
                indent_level : 4,
                quote_keys   : false,
                space_colon  : false,
                beautify     : false,
                ascii_only   : false,
                inline_script: false
        });
        var beautify = !!options.beautify;
        var indentation = 0,
            newline = beautify ? "\n" : "",
            space = beautify ? " " : "";

        function encode_string(str) {
                var ret = make_string(str, options.ascii_only);
                if (options.inline_script)
                        ret = ret.replace(/<\x2fscript([>\/\t\n\f\r ])/gi, "<\\/script$1");
                return ret;
        };

        function make_name(name) {
                name = name.toString();
                if (options.ascii_only)
                        name = to_ascii(name);
                return name;
        };

        function indent(line) {
                if (line == null)
                        line = "";
                if (beautify)
                        line = repeat_string(" ", options.indent_start + indentation * options.indent_level) + line;
                return line;
        };

        function with_indent(cont, incr) {
                if (incr == null) incr = 1;
                indentation += incr;
                try { return cont.apply(null, slice(arguments, 1)); }
                finally { indentation -= incr; }
        };

        function add_spaces(a) {
                if (beautify)
                        return a.join(" ");
                var b = [];
                for (var i = 0; i < a.length; ++i) {
                        var next = a[i + 1];
                        b.push(a[i]);
                        if (next &&
                            ((/[a-z0-9_\x24]$/i.test(a[i].toString()) && /^[a-z0-9_\x24]/i.test(next.toString())) ||
                             (/[\+\-]$/.test(a[i].toString()) && /^[\+\-]/.test(next.toString())))) {
                                b.push(" ");
                        }
                }
                return b.join("");
        };

        function add_commas(a) {
                return a.join("," + space);
        };

        function parenthesize(expr) {
                var gen = make(expr);
                for (var i = 1; i < arguments.length; ++i) {
                        var el = arguments[i];
                        if ((el instanceof Function && el(expr)) || expr[0] == el)
                                return "(" + gen + ")";
                }
                return gen;
        };

        function best_of(a) {
                if (a.length == 1) {
                        return a[0];
                }
                if (a.length == 2) {
                        var b = a[1];
                        a = a[0];
                        return a.length <= b.length ? a : b;
                }
                return best_of([ a[0], best_of(a.slice(1)) ]);
        };

        function needs_parens(expr) {
                if (expr[0] == "function" || expr[0] == "object") {
                        // dot/call on a literal function requires the
                        // function literal itself to be parenthesized
                        // only if it's the first "thing" in a
                        // statement.  This means that the parent is
                        // "stat", but it could also be a "seq" and
                        // we're the first in this "seq" and the
                        // parent is "stat", and so on.  Messy stuff,
                        // but it worths the trouble.
                        var a = slice(w.stack()), self = a.pop(), p = a.pop();
                        while (p) {
                                if (p[0] == "stat") return true;
                                if (((p[0] == "seq" || p[0] == "call" || p[0] == "dot" || p[0] == "sub" || p[0] == "conditional") && p[1] === self) ||
                                    ((p[0] == "binary" || p[0] == "assign" || p[0] == "unary-postfix") && p[2] === self)) {
                                        self = p;
                                        p = a.pop();
                                } else {
                                        return false;
                                }
                        }
                }
                return !HOP(DOT_CALL_NO_PARENS, expr[0]);
        };

        function make_num(num) {
                var str = num.toString(10), a = [ str.replace(/^0\./, ".") ], m;
                if (Math.floor(num) === num) {
                        if (num >= 0) {
                                a.push("0x" + num.toString(16).toLowerCase(), // probably pointless
                                       "0" + num.toString(8)); // same.
                        } else {
                                a.push("-0x" + (-num).toString(16).toLowerCase(), // probably pointless
                                       "-0" + (-num).toString(8)); // same.
                        }
                        if ((m = /^(.*?)(0+)$/.exec(num))) {
                                a.push(m[1] + "e" + m[2].length);
                        }
                } else if ((m = /^0?\.(0+)(.*)$/.exec(num))) {
                        a.push(m[2] + "e-" + (m[1].length + m[2].length),
                               str.substr(str.indexOf(".")));
                }
                return best_of(a);
        };

        var w = ast_walker();
        var make = w.walk;
        return w.with_walkers({
                "string": encode_string,
                "num": make_num,
                "name": make_name,
                "toplevel": function(statements) {
                        return make_block_statements(statements)
                                .join(newline + newline);
                },
                "splice": function(statements) {
                        var parent = w.parent();
                        if (HOP(SPLICE_NEEDS_BRACKETS, parent)) {
                                // we need block brackets in this case
                                return make_block.apply(this, arguments);
                        } else {
                                return MAP(make_block_statements(statements, true),
                                           function(line, i) {
                                                   // the first line is already indented
                                                   return i > 0 ? indent(line) : line;
                                           }).join(newline);
                        }
                },
                "block": make_block,
                "var": function(defs) {
                        return "var " + add_commas(MAP(defs, make_1vardef)) + ";";
                },
                "const": function(defs) {
                        return "const " + add_commas(MAP(defs, make_1vardef)) + ";";
                },
                "try": function(tr, ca, fi) {
                        var out = [ "try", make_block(tr) ];
                        if (ca) out.push("catch", "(" + ca[0] + ")", make_block(ca[1]));
                        if (fi) out.push("finally", make_block(fi));
                        return add_spaces(out);
                },
                "throw": function(expr) {
                        return add_spaces([ "throw", make(expr) ]) + ";";
                },
                "new": function(ctor, args) {
                        args = args.length > 0 ? "(" + add_commas(MAP(args, function(expr){
                                return parenthesize(expr, "seq");
                        })) + ")" : "";
                        return add_spaces([ "new", parenthesize(ctor, "seq", "binary", "conditional", "assign", function(expr){
                                var w = ast_walker(), has_call = {};
                                try {
                                        w.with_walkers({
                                                "call": function() { throw has_call },
                                                "function": function() { return this }
                                        }, function(){
                                                w.walk(expr);
                                        });
                                } catch(ex) {
                                        if (ex === has_call)
                                                return true;
                                        throw ex;
                                }
                        }) + args ]);
                },
                "switch": function(expr, body) {
                        return add_spaces([ "switch", "(" + make(expr) + ")", make_switch_block(body) ]);
                },
                "break": function(label) {
                        var out = "break";
                        if (label != null)
                                out += " " + make_name(label);
                        return out + ";";
                },
                "continue": function(label) {
                        var out = "continue";
                        if (label != null)
                                out += " " + make_name(label);
                        return out + ";";
                },
                "conditional": function(co, th, el) {
                        return add_spaces([ parenthesize(co, "assign", "seq", "conditional"), "?",
                                            parenthesize(th, "seq"), ":",
                                            parenthesize(el, "seq") ]);
                },
                "assign": function(op, lvalue, rvalue) {
                        if (op && op !== true) op += "=";
                        else op = "=";
                        return add_spaces([ make(lvalue), op, parenthesize(rvalue, "seq") ]);
                },
                "dot": function(expr) {
                        var out = make(expr), i = 1;
                        if (expr[0] == "num") {
                                if (!/\./.test(expr[1]))
                                        out += ".";
                        } else if (needs_parens(expr))
                                out = "(" + out + ")";
                        while (i < arguments.length)
                                out += "." + make_name(arguments[i++]);
                        return out;
                },
                "call": function(func, args) {
                        var f = make(func);
                        if (f.charAt(0) != "(" && needs_parens(func))
                                f = "(" + f + ")";
                        return f + "(" + add_commas(MAP(args, function(expr){
                                return parenthesize(expr, "seq");
                        })) + ")";
                },
                "function": make_function,
                "defun": make_function,
                "if": function(co, th, el) {
                        var out = [ "if", "(" + make(co) + ")", el ? make_then(th) : make(th) ];
                        if (el) {
                                out.push("else", make(el));
                        }
                        return add_spaces(out);
                },
                "for": function(init, cond, step, block) {
                        var out = [ "for" ];
                        init = (init != null ? make(init) : "").replace(/;*\s*$/, ";" + space);
                        cond = (cond != null ? make(cond) : "").replace(/;*\s*$/, ";" + space);
                        step = (step != null ? make(step) : "").replace(/;*\s*$/, "");
                        var args = init + cond + step;
                        if (args == "; ; ") args = ";;";
                        out.push("(" + args + ")", make(block));
                        return add_spaces(out);
                },
                "for-in": function(vvar, key, hash, block) {
                        return add_spaces([ "for", "(" +
                                            (vvar ? make(vvar).replace(/;+$/, "") : make(key)),
                                            "in",
                                            make(hash) + ")", make(block) ]);
                },
                "while": function(condition, block) {
                        return add_spaces([ "while", "(" + make(condition) + ")", make(block) ]);
                },
                "do": function(condition, block) {
                        return add_spaces([ "do", make(block), "while", "(" + make(condition) + ")" ]) + ";";
                },
                "return": function(expr) {
                        var out = [ "return" ];
                        if (expr != null) out.push(make(expr));
                        return add_spaces(out) + ";";
                },
                "binary": function(operator, lvalue, rvalue) {
                        var left = make(lvalue), right = make(rvalue);
                        // XXX: I'm pretty sure other cases will bite here.
                        //      we need to be smarter.
                        //      adding parens all the time is the safest bet.
                        if (member(lvalue[0], [ "assign", "conditional", "seq" ]) ||
                            lvalue[0] == "binary" && PRECEDENCE[operator] > PRECEDENCE[lvalue[1]] ||
                            lvalue[0] == "function" && needs_parens(this)) {
                                left = "(" + left + ")";
                        }
                        if (member(rvalue[0], [ "assign", "conditional", "seq" ]) ||
                            rvalue[0] == "binary" && PRECEDENCE[operator] >= PRECEDENCE[rvalue[1]] &&
                            !(rvalue[1] == operator && member(operator, [ "&&", "||", "*" ]))) {
                                right = "(" + right + ")";
                        }
                        else if (!beautify && options.inline_script && (operator == "<" || operator == "<<")
                                 && rvalue[0] == "regexp" && /^script/i.test(rvalue[1])) {
                                right = " " + right;
                        }
                        return add_spaces([ left, operator, right ]);
                },
                "unary-prefix": function(operator, expr) {
                        var val = make(expr);
                        if (!(expr[0] == "num" || (expr[0] == "unary-prefix" && !HOP(OPERATORS, operator + expr[1])) || !needs_parens(expr)))
                                val = "(" + val + ")";
                        return operator + (jsp.is_alphanumeric_char(operator.charAt(0)) ? " " : "") + val;
                },
                "unary-postfix": function(operator, expr) {
                        var val = make(expr);
                        if (!(expr[0] == "num" || (expr[0] == "unary-postfix" && !HOP(OPERATORS, operator + expr[1])) || !needs_parens(expr)))
                                val = "(" + val + ")";
                        return val + operator;
                },
                "sub": function(expr, subscript) {
                        var hash = make(expr);
                        if (needs_parens(expr))
                                hash = "(" + hash + ")";
                        return hash + "[" + make(subscript) + "]";
                },
                "object": function(props) {
                        var obj_needs_parens = needs_parens(this);
                        if (props.length == 0)
                                return obj_needs_parens ? "({})" : "{}";
                        var out = "{" + newline + with_indent(function(){
                                return MAP(props, function(p){
                                        if (p.length == 3) {
                                                // getter/setter.  The name is in p[0], the arg.list in p[1][2], the
                                                // body in p[1][3] and type ("get" / "set") in p[2].
                                                return indent(make_function(p[0], p[1][2], p[1][3], p[2]));
                                        }
                                        var key = p[0], val = parenthesize(p[1], "seq");
                                        if (options.quote_keys) {
                                                key = encode_string(key);
                                        } else if ((typeof key == "number" || !beautify && +key + "" == key)
                                                   && parseFloat(key) >= 0) {
                                                key = make_num(+key);
                                        } else if (!is_identifier(key)) {
                                                key = encode_string(key);
                                        }
                                        return indent(add_spaces(beautify && options.space_colon
                                                                 ? [ key, ":", val ]
                                                                 : [ key + ":", val ]));
                                }).join("," + newline);
                        }) + newline + indent("}");
                        return obj_needs_parens ? "(" + out + ")" : out;
                },
                "regexp": function(rx, mods) {
                        return "/" + rx + "/" + mods;
                },
                "array": function(elements) {
                        if (elements.length == 0) return "[]";
                        return add_spaces([ "[", add_commas(MAP(elements, function(el, i){
                                if (!beautify && el[0] == "atom" && el[1] == "undefined") return i === elements.length - 1 ? "," : "";
                                return parenthesize(el, "seq");
                        })), "]" ]);
                },
                "stat": function(stmt) {
                        return make(stmt).replace(/;*\s*$/, ";");
                },
                "seq": function() {
                        return add_commas(MAP(slice(arguments), make));
                },
                "label": function(name, block) {
                        return add_spaces([ make_name(name), ":", make(block) ]);
                },
                "with": function(expr, block) {
                        return add_spaces([ "with", "(" + make(expr) + ")", make(block) ]);
                },
                "atom": function(name) {
                        return make_name(name);
                }
        }, function(){ return make(ast) });

        // The squeezer replaces "block"-s that contain only a single
        // statement with the statement itself; technically, the AST
        // is correct, but this can create problems when we output an
        // IF having an ELSE clause where the THEN clause ends in an
        // IF *without* an ELSE block (then the outer ELSE would refer
        // to the inner IF).  This function checks for this case and
        // adds the block brackets if needed.
        function make_then(th) {
                if (th == null) return ";";
                if (th[0] == "do") {
                        // https://github.com/mishoo/UglifyJS/issues/#issue/57
                        // IE croaks with "syntax error" on code like this:
                        //     if (foo) do ... while(cond); else ...
                        // we need block brackets around do/while
                        return make_block([ th ]);
                }
                var b = th;
                while (true) {
                        var type = b[0];
                        if (type == "if") {
                                if (!b[3])
                                        // no else, we must add the block
                                        return make([ "block", [ th ]]);
                                b = b[3];
                        }
                        else if (type == "while" || type == "do") b = b[2];
                        else if (type == "for" || type == "for-in") b = b[4];
                        else break;
                }
                return make(th);
        };

        function make_function(name, args, body, keyword) {
                var out = keyword || "function";
                if (name) {
                        out += " " + make_name(name);
                }
                out += "(" + add_commas(MAP(args, make_name)) + ")";
                out = add_spaces([ out, make_block(body) ]);
                return needs_parens(this) ? "(" + out + ")" : out;
        };

        function must_has_semicolon(node) {
                switch (node[0]) {
                    case "with":
                    case "while":
                        return empty(node[2]); // `with' or `while' with empty body?
                    case "for":
                    case "for-in":
                        return empty(node[4]); // `for' with empty body?
                    case "if":
                        if (empty(node[2]) && !node[3]) return true; // `if' with empty `then' and no `else'
                        if (node[3]) {
                                if (empty(node[3])) return true; // `else' present but empty
                                return must_has_semicolon(node[3]); // dive into the `else' branch
                        }
                        return must_has_semicolon(node[2]); // dive into the `then' branch
                }
        };

        function make_block_statements(statements, noindent) {
                for (var a = [], last = statements.length - 1, i = 0; i <= last; ++i) {
                        var stat = statements[i];
                        var code = make(stat);
                        if (code != ";") {
                                if (!beautify && i == last && !must_has_semicolon(stat)) {
                                        code = code.replace(/;+\s*$/, "");
                                }
                                a.push(code);
                        }
                }
                return noindent ? a : MAP(a, indent);
        };

        function make_switch_block(body) {
                var n = body.length;
                if (n == 0) return "{}";
                return "{" + newline + MAP(body, function(branch, i){
                        var has_body = branch[1].length > 0, code = with_indent(function(){
                                return indent(branch[0]
                                              ? add_spaces([ "case", make(branch[0]) + ":" ])
                                              : "default:");
                        }, 0.5) + (has_body ? newline + with_indent(function(){
                                return make_block_statements(branch[1]).join(newline);
                        }) : "");
                        if (!beautify && has_body && i < n - 1)
                                code += ";";
                        return code;
                }).join(newline) + newline + indent("}");
        };

        function make_block(statements) {
                if (!statements) return ";";
                if (statements.length == 0) return "{}";
                return "{" + newline + with_indent(function(){
                        return make_block_statements(statements).join(newline);
                }) + newline + indent("}");
        };

        function make_1vardef(def) {
                var name = def[0], val = def[1];
                if (val != null)
                        name = add_spaces([ make_name(name), "=", parenthesize(val, "seq") ]);
                return name;
        };

};

function split_lines(code, max_line_length) {
        var splits = [ 0 ];
        jsp.parse(function(){
                var next_token = jsp.tokenizer(code);
                var last_split = 0;
                var prev_token;
                function current_length(tok) {
                        return tok.pos - last_split;
                };
                function split_here(tok) {
                        last_split = tok.pos;
                        splits.push(last_split);
                };
                function custom(){
                        var tok = next_token.apply(this, arguments);
                        out: {
                                if (prev_token) {
                                        if (prev_token.type == "keyword") break out;
                                }
                                if (current_length(tok) > max_line_length) {
                                        switch (tok.type) {
                                            case "keyword":
                                            case "atom":
                                            case "name":
                                            case "punc":
                                                split_here(tok);
                                                break out;
                                        }
                                }
                        }
                        prev_token = tok;
                        return tok;
                };
                custom.context = function() {
                        return next_token.context.apply(this, arguments);
                };
                return custom;
        }());
        return splits.map(function(pos, i){
                return code.substring(pos, splits[i + 1] || code.length);
        }).join("\n");
};

/* -----[ Utilities ]----- */

function repeat_string(str, i) {
        if (i <= 0) return "";
        if (i == 1) return str;
        var d = repeat_string(str, i >> 1);
        d += d;
        if (i & 1) d += str;
        return d;
};

function defaults(args, defs) {
        var ret = {};
        if (args === true)
                args = {};
        for (var i in defs) if (HOP(defs, i)) {
                ret[i] = (args && HOP(args, i)) ? args[i] : defs[i];
        }
        return ret;
};

function is_identifier(name) {
        return /^[a-z_$][a-z0-9_$]*$/i.test(name)
                && name != "this"
                && !HOP(jsp.KEYWORDS_ATOM, name)
                && !HOP(jsp.RESERVED_WORDS, name)
                && !HOP(jsp.KEYWORDS, name);
};

function HOP(obj, prop) {
        return Object.prototype.hasOwnProperty.call(obj, prop);
};

// some utilities

var MAP;

(function(){
        MAP = function(a, f, o) {
                var ret = [], top = [], i;
                function doit() {
                        var val = f.call(o, a[i], i);
                        if (val instanceof AtTop) {
                                val = val.v;
                                if (val instanceof Splice) {
                                        top.push.apply(top, val.v);
                                } else {
                                        top.push(val);
                                }
                        }
                        else if (val != skip) {
                                if (val instanceof Splice) {
                                        ret.push.apply(ret, val.v);
                                } else {
                                        ret.push(val);
                                }
                        }
                };
                if (a instanceof Array) for (i = 0; i < a.length; ++i) doit();
                else for (i in a) if (HOP(a, i)) doit();
                return top.concat(ret);
        };
        MAP.at_top = function(val) { return new AtTop(val) };
        MAP.splice = function(val) { return new Splice(val) };
        var skip = MAP.skip = {};
        function AtTop(val) { this.v = val };
        function Splice(val) { this.v = val };
})();

/* -----[ Exports ]----- */

exports.ast_walker = ast_walker;
exports.ast_mangle = ast_mangle;
exports.ast_squeeze = ast_squeeze;
exports.ast_lift_variables = ast_lift_variables;
exports.gen_code = gen_code;
exports.ast_add_scope = ast_add_scope;
exports.set_logger = function(logger) { warn = logger };
exports.make_string = make_string;
exports.split_lines = split_lines;
exports.MAP = MAP;

// keep this last!
exports.ast_squeeze_more = require("./squeeze-more").ast_squeeze_more;

});
define('volo/uglifyjs/index',["require", "exports", "module", "./parse-js", "./process"], function(require, exports, module) {

//convienence function(src, [options]);
function uglify(orig_code, options){
  options || (options = {});
  var jsp = uglify.parser;
  var pro = uglify.uglify;

  var ast = jsp.parse(orig_code, options.strict_semicolons); // parse code and get the initial AST
  ast = pro.ast_mangle(ast, options.mangle_options); // get a new AST with mangled names
  ast = pro.ast_squeeze(ast, options.squeeze_options); // get an AST with compression optimizations
  var final_code = pro.gen_code(ast, options.gen_options); // compressed code here
  return final_code;
};

uglify.parser = require("./parse-js");
uglify.uglify = require("./process");

module.exports = uglify

});
/**
 * @license Copyright (c) 2010-2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/jrburke/requirejs for details
 */

/*jslint plusplus: false, strict: false */
/*global define: false */

define('volo/parse',['./uglifyjs/index'], function (uglify) {
    var parser = uglify.parser,
        processor = uglify.uglify,
        ostring = Object.prototype.toString,
        isArray;

    if (Array.isArray) {
        isArray = Array.isArray;
    } else {
        isArray = function (it) {
            return ostring.call(it) === "[object Array]";
        };
    }

    /**
     * Determines if the AST node is an array literal
     */
    function isArrayLiteral(node) {
        return node[0] === 'array';
    }

    /**
     * Determines if the AST node is an object literal
     */
    function isObjectLiteral(node) {
        return node[0] === 'object';
    }

    /**
     * Converts a regular JS array of strings to an AST node that
     * represents that array.
     * @param {Array} ary
     * @param {Node} an AST node that represents an array of strings.
     */
    function toAstArray(ary) {
        var output = [
            'array',
            []
        ],
        i, item;

        for (i = 0; (item = ary[i]); i++) {
            output[1].push([
                'string',
                item
            ]);
        }

        return output;
    }

    /**
     * Validates a node as being an object literal (like for i18n bundles)
     * or an array literal with just string members. If an array literal,
     * only return array members that are full strings. So the caller of
     * this function should use the return value as the new value for the
     * node.
     *
     * This function does not need to worry about comments, they are not
     * present in this AST.
     *
     * @param {Node} node an AST node.
     *
     * @returns {Node} an AST node to use for the valid dependencies.
     * If null is returned, then it means the input node was not a valid
     * dependency.
     */
    function validateDeps(node) {
        var newDeps = ['array', []],
            arrayArgs, i, dep;

        if (!node) {
            return null;
        }

        if (isObjectLiteral(node) || node[0] === 'function') {
            return node;
        }

        //Dependencies can be an object literal or an array.
        if (!isArrayLiteral(node)) {
            return null;
        }

        arrayArgs = node[1];

        for (i = 0; i < arrayArgs.length; i++) {
            dep = arrayArgs[i];
            if (dep[0] === 'string') {
                newDeps[1].push(dep);
            }
        }
        return newDeps[1].length ? newDeps : null;
    }

    /**
     * Gets dependencies from a node, but only if it is an array literal,
     * and only if the dependency is a string literal.
     *
     * This function does not need to worry about comments, they are not
     * present in this AST.
     *
     * @param {Node} node an AST node.
     *
     * @returns {Array} of valid dependencies.
     * If null is returned, then it means the input node was not a valid
     * array literal, or did not have any string literals..
     */
    function getValidDeps(node) {
        var newDeps = [],
            arrayArgs, i, dep;

        if (!node) {
            return null;
        }

        if (isObjectLiteral(node) || node[0] === 'function') {
            return null;
        }

        //Dependencies can be an object literal or an array.
        if (!isArrayLiteral(node)) {
            return null;
        }

        arrayArgs = node[1];

        for (i = 0; i < arrayArgs.length; i++) {
            dep = arrayArgs[i];
            if (dep[0] === 'string') {
                newDeps.push(dep[1]);
            }
        }
        return newDeps.length ? newDeps : null;
    }

    /**
     * Main parse function. Returns a string of any valid require or define/require.def
     * calls as part of one JavaScript source string.
     * @param {String} moduleName the module name that represents this file.
     * It is used to create a default define if there is not one already for the file.
     * This allows properly tracing dependencies for builds. Otherwise, if
     * the file just has a require() call, the file dependencies will not be
     * properly reflected: the file will come before its dependencies.
     * @param {String} moduleName
     * @param {String} fileName
     * @param {String} fileContents
     * @param {Object} options optional options. insertNeedsDefine: true will
     * add calls to require.needsDefine() if appropriate.
     * @returns {String} JS source string or null, if no require or define/require.def
     * calls are found.
     */
    function parse(moduleName, fileName, fileContents, options) {
        options = options || {};

        //Set up source input
        var moduleDeps = [],
            result = '',
            moduleList = [],
            needsDefine = true,
            astRoot = parser.parse(fileContents),
            i, moduleCall, depString;

        parse.recurse(astRoot, function (callName, config, name, deps) {
            //If name is an array, it means it is an anonymous module,
            //so adjust args appropriately. An anonymous module could
            //have a FUNCTION as the name type, but just ignore those
            //since we just want to find dependencies.
            if (name && isArrayLiteral(name)) {
                deps = name;
                name = null;
            }

            if (!(deps = getValidDeps(deps))) {
                deps = [];
            }

            //Get the name as a string literal, if it is available.
            if (name && name[0] === 'string') {
                name = name[1];
            } else {
                name = null;
            }

            if (callName === 'define' && (!name || name === moduleName)) {
                needsDefine = false;
            }

            if (!name) {
                //If there is no module name, the dependencies are for
                //this file/default module name.
                moduleDeps = moduleDeps.concat(deps);
            } else {
                moduleList.push({
                    name: name,
                    deps: deps
                });
            }

            //If define was found, no need to dive deeper, unless
            //the config explicitly wants to dig deeper.
            return !options.findNestedDependencies;
        }, options);

        if (options.insertNeedsDefine && needsDefine) {
            result += 'require.needsDefine("' + moduleName + '");';
        }

        if (moduleDeps.length || moduleList.length) {
            for (i = 0; (moduleCall = moduleList[i]); i++) {
                if (result) {
                    result += '\n';
                }

                //If this is the main module for this file, combine any
                //"anonymous" dependencies (could come from a nested require
                //call) with this module.
                if (moduleCall.name === moduleName) {
                    moduleCall.deps = moduleCall.deps.concat(moduleDeps);
                    moduleDeps = [];
                }

                depString = moduleCall.deps.length ? '["' + moduleCall.deps.join('","') + '"]' : '[]';
                result += 'define("' + moduleCall.name + '",' + depString + ');';
            }
            if (moduleDeps.length) {
                if (result) {
                    result += '\n';
                }
                depString = moduleDeps.length ? '["' + moduleDeps.join('","') + '"]' : '[]';
                result += 'define("' + moduleName + '",' + depString + ');';
            }
        }

        return result ? result : null;
    }

    //Add some private methods to object for use in derived objects.
    parse.isArray = isArray;
    parse.isObjectLiteral = isObjectLiteral;
    parse.isArrayLiteral = isArrayLiteral;

    /**
     * Handles parsing a file recursively for require calls.
     * @param {Array} parentNode the AST node to start with.
     * @param {Function} onMatch function to call on a parse match.
     * @param {Object} [options] This is normally the build config options if
     * it is passed.
     * @param {Function} [recurseCallback] function to call on each valid
     * node, defaults to parse.parseNode.
     */
    parse.recurse = function (parentNode, onMatch, options, recurseCallback) {
        var hasHas = options && options.has,
            i, node;

        recurseCallback = recurseCallback || this.parseNode;

        if (isArray(parentNode)) {
            for (i = 0; i < parentNode.length; i++) {
                node = parentNode[i];
                if (isArray(node)) {
                    //If has config is in play, if calls have been converted
                    //by this point to be true/false values. So, if
                    //options has a 'has' value, skip if branches that have
                    //literal false values.

                    //uglify returns if constructs in an array:
                    //[0]: 'if'
                    //[1]: the condition, ['name', true | false] for the has replaced case.
                    //[2]: the block to process if true
                    //[3]: the block to process if false
                    //For if/else if/else, the else if is in the [3],
                    //so only ever have to deal with this structure.
                    if (hasHas && node[0] === 'if' && node[1] && node[1][0] === 'name' &&
                        (node[1][1] === 'true' || node[1][1] === 'false')) {
                        if (node[1][1] === 'true') {
                            this.recurse([node[2]], onMatch, options, recurseCallback);
                        } else {
                            this.recurse([node[3]], onMatch, options, recurseCallback);
                        }
                    } else {
                        if (recurseCallback(node, onMatch)) {
                            //The onMatch indicated parsing should
                            //stop for children of this node.
                            continue;
                        }
                        this.recurse(node, onMatch, options, recurseCallback);
                    }
                }
            }
        }
    };

    /**
     * Determines if the file defines require().
     * @param {String} fileName
     * @param {String} fileContents
     * @returns {Boolean}
     */
    parse.definesRequire = function (fileName, fileContents) {
        var astRoot = parser.parse(fileContents);
        return this.nodeHasRequire(astRoot);
    };

    /**
     * Finds require("") calls inside a CommonJS anonymous module wrapped in a
     * define(function(require, exports, module){}) wrapper. These dependencies
     * will be added to a modified define() call that lists the dependencies
     * on the outside of the function.
     * @param {String} fileName
     * @param {String} fileContents
     * @returns {Array} an array of module names that are dependencies. Always
     * returns an array, but could be of length zero.
     */
    parse.getAnonDeps = function (fileName, fileContents) {
        var astRoot = parser.parse(fileContents),
            defFunc = this.findAnonDefineFactory(astRoot);

        return parse.getAnonDepsFromNode(defFunc);
    };

    /**
     * Finds require("") calls inside a CommonJS anonymous module wrapped
     * in a define function, given an AST node for the definition function.
     * @param {Node} node the AST node for the definition function.
     * @returns {Array} and array of dependency names. Can be of zero length.
     */
    parse.getAnonDepsFromNode = function (node) {
        var deps = [],
            funcArgLength;

        if (node) {
            this.findRequireDepNames(node, deps);

            //If no deps, still add the standard CommonJS require, exports, module,
            //in that order, to the deps, but only if specified as function args.
            //In particular, if exports is used, it is favored over the return
            //value of the function, so only add it if asked.
            funcArgLength = node[2] && node[2].length;
            if (funcArgLength) {
                deps = (funcArgLength > 1 ? ["require", "exports", "module"] :
                        ["require"]).concat(deps);
            }
        }
        return deps;
    };

    /**
     * Finds the function in define(function (require, exports, module){});
     * @param {Array} node
     * @returns {Boolean}
     */
    parse.findAnonDefineFactory = function (node) {
        var callback, i, n, call, args;

        if (isArray(node)) {
            if (node[0] === 'call') {
                call = node[1];
                args = node[2];
                if ((call[0] === 'name' && call[1] === 'define') ||
                           (call[0] === 'dot' && call[1][1] === 'require' && call[2] === 'def')) {

                    //There should only be one argument and it should be a function,
                    //or a named module with function as second arg
                    if (args.length === 1 && args[0][0] === 'function') {
                        return args[0];
                    } else if (args.length === 2 && args[0][0] === 'string' &&
                               args[1][0] === 'function') {
                        return args[1];
                    }
                }
            }

            //Check child nodes
            for (i = 0; i < node.length; i++) {
                n = node[i];
                if ((callback = this.findAnonDefineFactory(n))) {
                    return callback;
                }
            }
        }

        return null;
    };

    /**
     * Finds any config that is passed to requirejs.
     * @param {String} fileName
     * @param {String} fileContents
     *
     * @returns {Object} a config object. Will be null if no config.
     * Can throw an error if the config in the file cannot be evaluated in
     * a build context to valid JavaScript.
     */
    parse.findConfig = function (fileName, fileContents) {
        /*jslint evil: true */
        //This is a litle bit inefficient, it ends up with two uglifyjs parser
        //calls. Can revisit later, but trying to build out larger functional
        //pieces first.
        var foundConfig = null,
            astRoot = parser.parse(fileContents);

        parse.recurse(astRoot, function (configNode) {
            var jsConfig;

            if (!foundConfig && configNode) {
                jsConfig = parse.nodeToString(configNode);
                foundConfig = eval('(' + jsConfig + ')');
                return foundConfig;
            }
            return undefined;
        }, null, parse.parseConfigNode);

        return foundConfig;
    };

    /**
     * Finds all dependencies specified in dependency arrays and inside
     * simplified commonjs wrappers.
     * @param {String} fileName
     * @param {String} fileContents
     *
     * @returns {Array} an array of dependency strings. The dependencies
     * have not been normalized, they may be relative IDs.
     */
    parse.findDependencies = function (fileName, fileContents, options) {
        //This is a litle bit inefficient, it ends up with two uglifyjs parser
        //calls. Can revisit later, but trying to build out larger functional
        //pieces first.
        var dependencies = [],
            astRoot = parser.parse(fileContents);

        parse.recurse(astRoot, function (callName, config, name, deps) {
            //Normalize the input args.
            if (name && isArrayLiteral(name)) {
                deps = name;
                name = null;
            }

            if ((deps = getValidDeps(deps))) {
                dependencies = dependencies.concat(deps);
            }
        }, options);

        return dependencies;
    };

    /**
     * Finds only CJS dependencies, ones that are the form require('stringLiteral')
     */
    parse.findCjsDependencies = function (fileName, fileContents, options) {
        //This is a litle bit inefficient, it ends up with two uglifyjs parser
        //calls. Can revisit later, but trying to build out larger functional
        //pieces first.
        var dependencies = [],
            astRoot = parser.parse(fileContents);

        parse.recurse(astRoot, function (dep) {
            dependencies.push(dep);
        }, options, function (node, onMatch) {

            var call, args;

            if (!isArray(node)) {
                return false;
            }

            if (node[0] === 'call') {
                call = node[1];
                args = node[2];

                if (call) {
                    //A require('') use.
                    if (call[0] === 'name' && call[1] === 'require' &&
                        args[0][0] === 'string') {
                        return onMatch(args[0][1]);
                    }
                }
            }

            return false;

        });

        return dependencies;
    };

    /**
     * Determines if define(), require({}|[]) or requirejs was called in the
     * file. Also finds out if define() is declared and if define.amd is called.
     */
    parse.usesAmdOrRequireJs = function (fileName, fileContents, options) {
        var astRoot = parser.parse(fileContents),
            uses;

        parse.recurse(astRoot, function (prop) {
            if (!uses) {
                uses = {};
            }
            uses[prop] = true;
        }, options, parse.findAmdOrRequireJsNode);

        return uses;
    };

    /**
     * Determines if require(''), exports.x =, module.exports =,
     * __dirname, __filename are used. So, not strictly traditional CommonJS,
     * also checks for Node variants.
     */
    parse.usesCommonJs = function (fileName, fileContents, options) {
        var uses = null,
            assignsExports = false,
            astRoot = parser.parse(fileContents);

        parse.recurse(astRoot, function (prop) {
            if (prop === 'varExports') {
                assignsExports = true;
            } else if (prop !== 'exports' || !assignsExports) {
                if (!uses) {
                    uses = {};
                }
                uses[prop] = true;
            }
        }, options, function (node, onMatch) {

            var call, args;

            if (!isArray(node)) {
                return false;
            }

            if (node[0] === 'name' && (node[1] === '__dirname' || node[1] === '__filename')) {
                return onMatch(node[1].substring(2));
            } else if (node[0] === 'var' && node[1] && node[1][0] && node[1][0][0] === 'exports') {
                //Hmm, a variable assignment for exports, so does not use cjs exports.
                return onMatch('varExports');
            } else if (node[0] === 'assign' && node[2] && node[2][0] === 'dot') {
                args = node[2][1];

                if (args) {
                    //An exports or module.exports assignment.
                    if (args[0] === 'name' && args[1] === 'module' &&
                        node[2][2] === 'exports') {
                        return onMatch('moduleExports');
                    } else if (args[0] === 'name' && args[1] === 'exports') {
                        return onMatch('exports');
                    }
                }
            } else if (node[0] === 'call') {
                call = node[1];
                args = node[2];

                if (call) {
                    //A require('') use.
                    if (call[0] === 'name' && call[1] === 'require' &&
                        args[0][0] === 'string') {
                        return onMatch('require');
                    }
                }
            }

            return false;

        });

        return uses;
    };


    parse.findRequireDepNames = function (node, deps) {
        var moduleName, i, n, call, args;

        if (isArray(node)) {
            if (node[0] === 'call') {
                call = node[1];
                args = node[2];

                if (call && call[0] === 'name' && call[1] === 'require') {
                    moduleName = args[0];
                    if (moduleName[0] === 'string') {
                        deps.push(moduleName[1]);
                    }
                }


            }

            //Check child nodes
            for (i = 0; i < node.length; i++) {
                n = node[i];
                this.findRequireDepNames(n, deps);
            }
        }
    };

    /**
     * Determines if a given node contains a require() definition.
     * @param {Array} node
     * @returns {Boolean}
     */
    parse.nodeHasRequire = function (node) {
        if (this.isDefineNode(node)) {
            return true;
        }

        if (isArray(node)) {
            for (var i = 0, n; i < node.length; i++) {
                n = node[i];
                if (this.nodeHasRequire(n)) {
                    return true;
                }
            }
        }

        return false;
    };

    /**
     * Is the given node the actual definition of define(). Actually uses
     * the definition of define.amd to find require.
     * @param {Array} node
     * @returns {Boolean}
     */
    parse.isDefineNode = function (node) {
        //Actually look for the define.amd = assignment, since
        //that is more indicative of RequireJS vs a plain require definition.
        var assign;
        if (!node) {
            return null;
        }

        if (node[0] === 'assign' && node[1] === true) {
            assign = node[2];
            if (assign[0] === 'dot' && assign[1][0] === 'name' &&
                assign[1][1] === 'define' && assign[2] === 'amd') {
                return true;
            }
        }
        return false;
    };

    /**
     * Determines if a specific node is a valid require or define/require.def call.
     * @param {Array} node
     * @param {Function} onMatch a function to call when a match is found.
     * It is passed the match name, and the config, name, deps possible args.
     * The config, name and deps args are not normalized.
     *
     * @returns {String} a JS source string with the valid require/define call.
     * Otherwise null.
     */
    parse.parseNode = function (node, onMatch) {
        var call, name, config, deps, args, cjsDeps;

        if (!isArray(node)) {
            return false;
        }

        if (node[0] === 'call') {
            call = node[1];
            args = node[2];

            if (call) {
                if (call[0] === 'name' &&
                   (call[1] === 'require' || call[1] === 'requirejs')) {

                    //It is a plain require() call.
                    config = args[0];
                    deps = args[1];
                    if (isArrayLiteral(config)) {
                        deps = config;
                        config = null;
                    }

                    if (!(deps = validateDeps(deps))) {
                        return null;
                    }

                    return onMatch("require", null, null, deps);

                } else if (call[0] === 'name' && call[1] === 'define') {

                    //A define call
                    name = args[0];
                    deps = args[1];
                    //Only allow define calls that match what is expected
                    //in an AMD call:
                    //* first arg should be string, array, function or object
                    //* second arg optional, or array, function or object.
                    //This helps weed out calls to a non-AMD define, but it is
                    //not completely robust. Someone could create a define
                    //function that still matches this shape, but this is the
                    //best that is possible, and at least allows UglifyJS,
                    //which does create its own internal define in one file,
                    //to be inlined.
                    if (((name[0] === 'string' || isArrayLiteral(name) ||
                          name[0] === 'function' || isObjectLiteral(name))) &&
                        (!deps || isArrayLiteral(deps) ||
                         deps[0] === 'function' || isObjectLiteral(deps) ||
                         // allow define(['dep'], factory) pattern
                         (isArrayLiteral(name) && deps[0] === 'name' && args.length === 2))) {

                        //If first arg is a function, could be a commonjs wrapper,
                        //look inside for commonjs dependencies.
                        //Also, if deps is a function look for commonjs deps.
                        if (name && name[0] === 'function') {
                            cjsDeps = parse.getAnonDepsFromNode(name);
                            if (cjsDeps.length) {
                                name = toAstArray(cjsDeps);
                            }
                        } else if (deps && deps[0] === 'function') {
                            cjsDeps = parse.getAnonDepsFromNode(deps);
                            if (cjsDeps.length) {
                                deps = toAstArray(cjsDeps);
                            }
                        }

                        return onMatch("define", null, name, deps);
                    }
                }
            }
        }

        return false;
    };

    /**
     * Looks for define(), require({} || []), requirejs({} || []) calls.
     */
    parse.findAmdOrRequireJsNode = function (node, onMatch) {
        var call, args, configNode, type;

        if (!isArray(node)) {
            return false;
        }

        if (node[0] === 'defun' && node[1] === 'define') {
            type = 'declaresDefine';
        } else if (node[0] === 'assign' && node[2] && node[2][2] === 'amd' &&
            node[2][1] && node[2][1][0] === 'name' &&
            node[2][1][1] === 'define') {
            type = 'defineAmd';
        } else if (node[0] === 'call') {
            call = node[1];
            args = node[2];

            if (call) {
                if ((call[0] === 'dot' &&
                   (call[1] && call[1][0] === 'name' &&
                    (call[1][1] === 'require' || call[1][1] === 'requirejs')) &&
                   call[2] === 'config')) {
                    //A require.config() or requirejs.config() call.
                    type = call[1][1] + 'Config';
                } else if (call[0] === 'name' &&
                   (call[1] === 'require' || call[1] === 'requirejs')) {
                    //A require() or requirejs() config call.
                    //Only want ones that start with an object or an array.
                    configNode = args[0];
                    if (configNode[0] === 'object' || configNode[0] === 'array') {
                        type = call[1];
                    }
                } else if (call[0] === 'name' && call[1] === 'define') {
                    //A define call.
                    type = 'define';
                }
            }
        }

        if (type) {
            return onMatch(type);
        }

        return false;
    };

    /**
     * Determines if a specific node is a valid require/requirejs config
     * call. That includes calls to require/requirejs.config().
     * @param {Array} node
     * @param {Function} onMatch a function to call when a match is found.
     * It is passed the match name, and the config, name, deps possible args.
     * The config, name and deps args are not normalized.
     *
     * @returns {String} a JS source string with the valid require/define call.
     * Otherwise null.
     */
    parse.parseConfigNode = function (node, onMatch) {
        var call, configNode, args;

        if (!isArray(node)) {
            return false;
        }

        if (node[0] === 'call') {
            call = node[1];
            args = node[2];

            if (call) {
                //A require.config() or requirejs.config() call.
                if ((call[0] === 'dot' &&
                   (call[1] && call[1][0] === 'name' &&
                    (call[1][1] === 'require' || call[1][1] === 'requirejs')) &&
                   call[2] === 'config') ||
                   //A require() or requirejs() config call.

                   (call[0] === 'name' &&
                   (call[1] === 'require' || call[1] === 'requirejs'))
                ) {
                    //It is a plain require() call.
                    configNode = args[0];

                    if (configNode[0] !== 'object') {
                        return null;
                    }

                    return onMatch(configNode);

                }
            }
        }

        return false;
    };

    /**
     * Converts an AST node into a JS source string. Does not maintain formatting
     * or even comments from original source, just returns valid JS source.
     * @param {Array} node
     * @returns {String} a JS source string.
     */
    parse.nodeToString = function (node) {
        return processor.gen_code(node, true);
    };

    return parse;
});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint */
/*global define */

define('amdify',['require','exports','module','fs','path','volo/parse','volo/file','text!./amdify/template.js','text!./amdify/exportsTemplate.js','text!./amdify/exportsNoConflictTemplate.js','text!./amdify/doc.md','volo/commands'],function (require, exports, module) {
    var fs = require('fs'),
        path = require('path'),
        parse = require('volo/parse'),
        file = require('volo/file'),
        template = require('text!./amdify/template.js'),
        exportsTemplate = require('text!./amdify/exportsTemplate.js'),
        exportsNoConflictTemplate = require('text!./amdify/exportsNoConflictTemplate.js'),
        dependsRegExp = /\/\*DEPENDENCIES\*\//g,
        contentsComment = '/*CONTENTS*/',
        exportsRegExp = /\/\*EXPORTS\*\//g,
        main;

    main = {
        //Text summary used when listing commands.
        summary: 'Does a simple AMD wrapping for JS libraries that use ' +
                 'browser globals',

        doc: require('text!./amdify/doc.md'),

        flags: {
            'noConflict': 'noConflict'
        },

        //Validate any arguments here.
        validate: function (namedArgs, target) {
            if (!target) {
                return new Error('A target file needs to be specified');
            }

            if (!path.existsSync(target)) {
                return new Error(target + ' does not exist!');
            }

            return undefined;
        },

        run: function (deferred, v, namedArgs, target) {
            var depends = namedArgs.depends,
                exports = namedArgs.exports || '',
                noConflict = namedArgs.noConflict,
                completeMessage = '',
                jsFiles;

            if (depends) {
                depends = depends.split(',').map(function (value) {
                    return "'" + value + "'";
                });
            } else {
                depends = [];
            }

            //Convert the depends to a string.
            depends = depends.join(',');

            if (fs.statSync(target).isDirectory()) {
                //Find all the .js files in the directory and convert them.
                jsFiles = file.getFilteredFileList(target, /\.js$/);
                jsFiles.forEach(function (file) {
                    var msg = main.util.convert(file, depends, exports, noConflict);
                    if (msg) {
                        completeMessage += (completeMessage ? '\n' : '') +  msg;
                    }
                });
                return deferred.resolve(completeMessage);
            } else {
                return deferred.resolve(main.util.convert(target, depends, exports, noConflict));
            }
        },

        util: {
            convert: function (target, depends, exports, noConflict) {
                var contents = fs.readFileSync(target, 'utf8'),
                    prelude = '',
                    temp, commentIndex, cjsProps, amdProps;

                if (contents.charAt(0) === '#') {
                    //This is probably an executable file for node, skip it.
                    return 'SKIP: ' + target + ': node executable script.';
                }

                amdProps = parse.usesAmdOrRequireJs(target, contents);
                if (amdProps && (!amdProps.declaresDefine ||
                                (amdProps.declaresDefine && amdProps.defineAmd))) {
                    //AMD in use, and it is not a file that declares a define()
                    //or if it does, does not declare define.amd.
                    return 'SKIP: ' + target + ': already uses AMD.';
                } else {
                    cjsProps = parse.usesCommonJs(target, contents);
                    //If no exports or depends and it looks like a cjs module convert
                    if (!exports && !depends && cjsProps) {
                        if (cjsProps.filename || cjsProps.dirname) {
                            prelude = "var __filename = module.uri, " +
                                      "__dirname = __filename.substring(0, __filename.lastIndexOf('/');";
                        }
                        //Just do a simple wrapper.
                        contents = 'define(function (require, exports, module) {' + prelude + '\n' +
                                    contents +
                                    '\n});';
                        fs.writeFileSync(target, contents, 'utf8');
                        return 'CONVERTED: ' + target + ': wrapped define().';
                    } else {
                        //Get the export boilerplate ready.
                        if (exports) {
                            exports = noConflict ?
                                        exportsNoConflictTemplate.replace(exportsRegExp, exports) :
                                        exportsTemplate.replace(exportsRegExp, exports);
                        }

                        //Create the main wrapping. Do depends and exports replacement
                        //before inserting the main contents, to avoid problems with
                        //a possibly undesirable regexp replacement.
                        temp = template
                                .replace(dependsRegExp, depends)
                                .replace(exportsRegExp, exports);

                        //Cannot use a regexp replacement for comment, because if
                        //the contents contain funky regexp associated markers, like
                        //a `$`, then get double content insertion.
                        commentIndex = temp.indexOf(contentsComment);
                        contents = temp.substring(0, commentIndex) +
                                   contents +
                                   temp.substring(commentIndex + contentsComment.length, temp.length);

                        fs.writeFileSync(target, contents, 'utf8');

                        return 'CONVERTED: ' + target + ': depends: ' + depends +
                               '; exports: ' + exports + '.';
                    }
                }
            }
        }
    };

    return require('volo/commands').register(module.id, main);
});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint */
/*global define, console, process */

define('add',['require','exports','module','fs','path','q','volo/config','volo/archive','volo/download','volo/packageJson','volo/parse','volo/tar','volo/file','volo/tempDir','amdify','text!./add/doc.md','volo/commands'],function (require, exports, module) {
    var fs = require('fs'),
        path = require('path'),
        q = require('q'),
        config = require('volo/config'),
        myConfig = config['volo/add'],
        archive = require('volo/archive'),
        download = require('volo/download'),
        packageJson = require('volo/packageJson'),
        parse = require('volo/parse'),
        tar = require('volo/tar'),
        file = require('volo/file'),
        tempDir = require('volo/tempDir'),
        amdify = require('amdify'),
        jsRegExp = /\.js$/,
        add;

    function makeMainAmdAdapter(mainValue, localName, targetFileName) {
        //Trim off any leading dot and file
        //extension, if they exist.
        var mainName = mainValue
                       .replace(/^\.\//, '')
                       .replace(/\.js$/, ''),
        contents;

        //Add in adapter module for AMD code
        contents = "define(['" + localName + "/" + mainName +
                   "'], function (main) {\n" +
                    "    return main;\n" +
                    "});";

        fs.writeFileSync(targetFileName, contents, 'utf8');
    }

    add = {
        summary: 'Add code to your project.',

        doc: require('text!./add/doc.md'),

        flags: {
            'f': 'force',
            'amd': 'amd',
            'amdlog': 'amdlog'
        },

        validate: function (namedArgs, archiveName, version) {
            if (!archiveName) {
                return new Error('Please specify an archive name or an URL.');
            }

            return undefined;
        },
        run: function (deferred, v, namedArgs, archiveName, specificLocalName) {

            q.when(archive.resolve(archiveName, namedArgs.volo.resolve), function (archiveInfo) {

                var pkg = packageJson('.'),
                    isAmdProject = namedArgs.amd || (pkg.data && pkg.data.amd),
                    baseUrl = pkg.data && pkg.data.amd && pkg.data.amd.baseUrl,
                    existingPath, tempDirName, linkPath, linkStat, linkTarget,
                    info;

                //If no baseUrl, then look for an existing js directory
                if (!baseUrl) {
                    baseUrl = path.join('.', 'js');
                    if (!path.existsSync(baseUrl)) {
                        //Allow for a 'scripts' option instead of js/, in case
                        //it is something uses transpiled scripts so 'js/'
                        //would not be accurate.
                        baseUrl = path.join('.', 'scripts');
                        if (!path.existsSync(baseUrl)) {
                            //No js or scripts subdir, so just use current
                            //directory.
                            baseUrl = '.';
                        }
                    }
                }

                //Store the final local name. Value given in add command
                //takes precedence over the calculated name.
                archiveInfo.finalLocalName = specificLocalName ||
                                             archiveInfo.localName;

                //If the archive scheme is just a symlink, set that up now,
                //then bail.
                if (archiveInfo.scheme === 'symlink') {
                    linkPath = path.resolve(archiveInfo.url.substring(archiveInfo.url.indexOf(':') + 1));

                    if (!path.existsSync(linkPath)) {
                        return deferred.reject(new Error(linkPath + ' does not exist'));
                    }

                    linkStat = fs.statSync(linkPath);
                    if (linkStat.isFile()) {
                        //Simple symlink.
                        linkTarget = path.join(baseUrl, archiveInfo.finalLocalName + '.js');
                        fs.symlinkSync(path.resolve(linkPath), linkTarget);
                    } else {
                        //A directory. Set the symlink.
                        linkTarget = path.join(baseUrl, archiveInfo.finalLocalName);
                        fs.symlinkSync(linkPath, linkTarget);

                        //Create an adapter module if an AMD project.
                        info = packageJson(linkPath);
                        if (info.data.main && isAmdProject) {
                            makeMainAmdAdapter(info.data.main,
                                               archiveInfo.finalLocalName,
                                               linkTarget + '.js');
                        }
                    }

                    deferred.resolve(linkTarget + ' points to ' + linkPath +
                                         (isAmdProject ?
                                          '\nThe AMD dependency name: \'' +
                                          archiveInfo.finalLocalName :
                                          ''));
                }

                //Function used to clean up in case of errors.
                function errCleanUp(err) {
                    file.rmdir(tempDirName);
                    deferred.reject(err);
                }

                //Function to handle moving the file(s) from temp dir to final
                //location.
                function moveFromTemp() {
                    try {
                        //Find the directory that was unpacked in tempDirName
                        var dirName = file.firstDir(tempDirName),
                            completeMessage = '',
                            info, sourceName, targetName,
                            rmPromises = [],
                            listing, defaultName, mainFile, mainContents, deps;

                        if (dirName) {
                            info = packageJson(dirName);

                            //If a main setting, read the main file. If it
                            //calls define() and any of the dependencies
                            //are relative, then keep the whole directory.
                            mainFile = info.data && info.data.main;
                            if (mainFile) {
                                mainFile += jsRegExp.test(mainFile) ? '' : '.js';
                                mainFile = path.join(dirName, mainFile);
                                mainContents = fs.readFileSync(mainFile, 'utf8');
                                deps = parse.findDependencies(mainFile,
                                       mainContents);
                                if (!deps || !deps.length) {
                                    deps = parse.findCjsDependencies(mainFile,
                                           mainContents);
                                }
                                if (deps && deps.some(function (dep) {
                                    return dep.indexOf('.') === 0;
                                })) {
                                    sourceName = null;
                                } else {
                                    sourceName = mainFile;
                                    defaultName = path.basename(mainFile);
                                }
                            } else {
                                //If the directory only contains one file, then
                                //that is the install target.
                                listing = fs.readdirSync(dirName);
                                if (listing.length === 1) {
                                    sourceName = path.join(dirName, listing[0]);
                                    defaultName = listing[0];
                                } else {
                                    //packagJson will look for one top level .js
                                    //file, and if so, and has package data via
                                    //a package.json comment, only install that
                                    //file.
                                    if (info.singleFile && info.data) {
                                        sourceName = info.singleFile;
                                        defaultName = path.basename(info.file);
                                    } else {
                                        defaultName = archiveInfo.finalLocalName + '.js';

                                        sourceName = path.join(dirName, defaultName);
                                        if (!path.existsSync(sourceName)) {
                                            sourceName = null;
                                        }
                                    }
                                }
                            }

                            if (sourceName) {
                                //Just move the single file into position.
                                if (specificLocalName) {
                                    targetName = path.join(baseUrl,
                                                           specificLocalName +
                                                           '.js');
                                } else {
                                    targetName = path.join(baseUrl, defaultName);
                                }

                                //Check for the existence of the
                                //singleFileName, and if it already exists,
                                //bail out.
                                if (path.existsSync(targetName) &&
                                    !namedArgs.force) {
                                    errCleanUp(targetName + ' already exists.' +
                                        ' To install anyway, pass -f to the ' +
                                        'command');
                                    return;
                                }
                                fs.renameSync(sourceName, targetName);
                            } else {
                                //A complete directory install.
                                targetName = path.join(baseUrl,
                                                       archiveInfo.finalLocalName);

                                //Found the unpacked directory, move it.
                                fs.renameSync(dirName, targetName);

                                //If directory, remove common directories not
                                //needed for install.
                                if (myConfig.discard) {
                                    fs.readdirSync(targetName).forEach(
                                        function (name) {
                                        if (myConfig.discard[name]) {
                                            rmPromises.push(file.rmdir(path.join(targetName,
                                                                     name)));
                                        }
                                    });
                                }

                                if (info.data.main && isAmdProject) {
                                    makeMainAmdAdapter(info.data.main,
                                                       archiveInfo.finalLocalName,
                                                       targetName + '.js');
                                }
                            }

                            //Stamp app's package.json with the dependency??

                            //Trace nested dependencies in the package.json
                            //TODO

                            q.call(function () {
                                //Wait for all the rm commands to finish.
                                if (rmPromises.length) {
                                    return q.all(rmPromises);
                                }
                                return undefined;
                            }).then(function () {
                                if (isAmdProject) {
                                    var damd = q.defer();
                                    amdify.run.apply(amdify, [damd, v, namedArgs, targetName]);
                                    return damd.promise;
                                }
                                return undefined;
                            }).then(function (amdMessage) {
                                //All done.
                                file.rmdir(tempDirName);
                                if (namedArgs.amdlog && amdMessage) {
                                    completeMessage += amdMessage + '\n';
                                }
                                completeMessage += 'Installed ' +
                                    archiveInfo.url +
                                    (archiveInfo.fragment ? '#' +
                                     archiveInfo.fragment : '') +
                                    ' at ' + targetName;

                                if (isAmdProject) {
                                    completeMessage += '\nAMD dependency name: ' +
                                                        archiveInfo.finalLocalName;
                                }

                                deferred.resolve(completeMessage);
                            }, deferred.reject);
                        } else {
                            errCleanUp('Unexpected tarball configuration');
                        }
                    } catch (e) {
                        errCleanUp(e);
                    }
                }

                try {
                    //If the baseUrl does not exist, create it.
                    file.mkdirs(baseUrl);

                    //Get the package JSON data for dependency, if it is
                    //already on disk.
                    existingPath = path.join(baseUrl, archiveInfo.finalLocalName);
                    if (!path.existsSync(existingPath)) {
                        existingPath += '.js';
                        if (!path.existsSync(existingPath)) {
                            existingPath = null;
                        }
                    }

                    pkg = (existingPath && packageJson(existingPath)) || {};

                    if (existingPath && !namedArgs.force) {
                        return deferred.reject(existingPath + ' already exists. To ' +
                                'install anyway, pass -f to the command');
                    }

                } catch (e) {
                    errCleanUp(e);
                }

                //Create a temporary directory to download the code.
                tempDir.create(archiveInfo.finalLocalName, function (newTempDir) {
                    tempDirName = newTempDir;

                    var url = archiveInfo.url,
                        localName = archiveInfo.finalLocalName,
                        lastDotIndex = url.lastIndexOf('.'),
                        ext, urlDir, tarName, downloadTarget, downloadPath;

                    if (archiveInfo.isArchive) {
                        ext = '.tar.gz';
                    } else if (lastDotIndex !== -1) {
                        ext = url.substring(lastDotIndex, url.length);
                    }

                    downloadTarget = localName + (ext || '');

                    if (archiveInfo.isArchive) {
                        download(url, path.join(tempDirName, downloadTarget),
                            function (filePath) {

                            //Unpack the zip file.
                            tarName = path.join(tempDirName, localName +
                                                '.tar.gz');
                            tar.untar(tarName, function () {
                                moveFromTemp();
                            }, errCleanUp);
                        }, errCleanUp);
                    } else {
                        if (ext) {
                            //Single file install.
                            //Create a directory inside tempDirName to receive the
                            //file, since the tarball path has a similar setup.
                            urlDir = path.join(tempDirName, 'download');
                            fs.mkdirSync(urlDir);
                            downloadPath = path.join(urlDir, downloadTarget);
                        } else {
                            //a local directory install, it already has
                            //a directory structure.
                            downloadPath = path.join(tempDirName, downloadTarget);
                        }

                        download(url, downloadPath,
                            function (filePath) {
                                moveFromTemp();
                            },
                            errCleanUp
                        );
                    }
                }, errCleanUp);

                return undefined;
            }, deferred.reject);
        }
    };

    return require('volo/commands').register(module.id, add);
});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint */
/*global define, console, process */

define('acquire',['require','exports','module','fs','q','path','add','text!./acquire/doc.md','volo/commands'],function (require, exports, module) {
    var fs = require('fs'),
        q = require('q'),
        path = require('path'),
        add = require('add'),
        acquire;

    acquire = {
        summary: 'Adds a new command to volo.',

        doc: require('text!./acquire/doc.md'),

        flags: add.flags,

        validate: function (namedArgs, appName) {
            return add.validate.apply(add, arguments);
        },

        run: function (deferred, v, namedArgs, packageName, localName) {
            //Create a 'volo' directory as a sibling to the volo.js file
            var execName = process.argv[1],
                dirName = path.dirname(execName),
                baseName = path.basename(execName, '.js'),
                targetDir = path.join(dirName, baseName),
                cwd = process.cwd(),
                d = q.defer(),
                args = [].slice.call(arguments, 0);

            //Swap in our deferred
            args[0] = d;

            //Create sibling directory to this file to store the
            //new command implementation.
            if (!path.existsSync(targetDir)) {
                fs.mkdirSync(targetDir);
            }

            process.chdir(targetDir);

            function finish(result) {
                process.chdir(cwd);
            }

            //Update the namedArgs to indicate amd is true for volo
            namedArgs.amd = true;

            add.run.apply(add, args);

            q.when(d.promise, function (result) {
                finish();
                deferred.resolve(result + '\nNew volo command aquired!');
            }, function (err) {
                finish();
                deferred.reject(err + message);
            });
        }
    };

    return require('volo/commands').register(module.id, acquire);
});

/**
 * @license Copyright (c) 2011, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/volojs/volo for details
 */


/*jslint */
/*global define, console, process */

define('rejuvenate',['require','exports','module','q','path','add','text!./rejuvenate/doc.md','volo/commands'],function (require, exports, module) {
    var q = require('q'),
        path = require('path'),
        add = require('add'),
        rejuvenate;

    rejuvenate = {
        summary: 'Updates volo.js to latest version.',

        doc: require('text!./rejuvenate/doc.md'),

        flags: add.flags,

        validate: function (namedArgs) {},

        run: function (deferred, v, namedArgs, from) {
            //Create a 'volo' directory as a sibling to the volo.js file
            var execName = process.argv[1],
                dirName = path.dirname(execName),
                baseName = path.basename(execName, '.js'),
                cwd = process.cwd(),
                d = q.defer();

            from = from || 'volojs/volo#dist/volo.js';

            //Change directory to the one holding volo.js
            process.chdir(dirName);

            function finish(result) {
                process.chdir(cwd);
            }

            //Set force: true in namedArgs so that add will do the
            //work even though volo.js exists.
            namedArgs.force = true;

            add.run(d, namedArgs, from, baseName);

            q.when(d.promise, function (result) {
                finish();
                deferred.resolve(result + '\n' + baseName + '.js has been updated!');
            }, function (err) {
                finish();
                deferred.reject(err);
            });
        }
    };

    return require('volo/commands').register(module.id, rejuvenate);
});

//Trigger processing of all defined modules.
requirejs(['volo/main']);

//Light it up! This call is separate because if main
//is called as part of first requirejs() call, all of
//the commands that are built into volo.js may not have
//been registered yet.
requirejs(['volo/main'], function (main) {
    //First two args are 'node' and 'volo.js'
    var args = process.argv.slice(2);

    main(args, function (message) {
        if (message) {
            console.log(message);
        }
    }, function (err) {
        console.log(err.toString());
        process.exit(1);
    });
});
