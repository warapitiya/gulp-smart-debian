'use strict';

const zlib = require('zlib');
const exec = require('child_process').exec;
const logger = require('gulplog');
const PluginError = require('plugin-error');
const through = require('through2');
const titleCase = require('title-case');
const fs = require('fs-extra');
const PACKAGE_NAME = 'gulp-smart-debian';

/**
 * DEB
 * @param files
 * @param pkg
 * @param cb
 * @returns {*}
 */
function deb(files, pkg, cb) {
    const ctrl = [];
    for (const _key in pkg) {
        ctrl.push(`${titleCase(_key)}: ${pkg[_key]}`);
    }
    ctrl.push(' ');
    return cb(null, ctrl);
}

/**
 * Changelog
 * @param pkg
 * @returns {Array}
 */
function changelog(pkg) {
    const log = [];
    if (pkg.changelog === undefined) {
        return log;
    }
    for (let i = 0; i < pkg.changelog.length; i++) {
        let header = `${pkg.package} (${pkg.changelog[i].version}) `;
        header += `${pkg.changelog[i].distribution}; urgency=${pkg.changelog[i].urgency}`;
        log.push(header + '\n');
        for (let x = 0; x < pkg.changelog[i].changes.length; x++) {
            log.push(`\t * ${pkg.changelog[i].changes[x]}`);
        }
        const ts = Date.parse(pkg.changelog[i].date);
        log.push(`\n-- ${pkg.maintainer} ${new Date(ts)}\n`);
    }
    return log;
}

/**
 * Install script
 * @param fn
 * @param script
 * @param out
 * @param cb
 */
function installScript(fn, script, out, cb) {
    if (script !== undefined && script.length > 0) {
        script.push('');
        const o = `${out}/DEBIAN/${fn}`;
        fs.outputFile(o, script.join('\n'), err => {
            if (err) {
                cb(new PluginError(PACKAGE_NAME, err));
                return;
            }
            fs.chmodSync(o, 0o0755);
        });
    }
}

/**
 * Start debian
 * @param pkg
 * @returns {*}
 */
function smartDeb(pkg) {
    const files = [];
    return through.obj(
        (file, enc, cb) => {
            if (file.isStream()) {
                cb(new PluginError(PACKAGE_NAME, 'Streaming not supported.'));
                return;
            }
            files.push(file);
            cb(null);
        },
        cb => {
            if (typeof pkg === 'string') {
                pkg = fs.readJSONSync(pkg);
            }
            deb(files, pkg, (err, ctrl) => {
                if (pkg._verbose === undefined) {
                    pkg._verbose = true;
                }
                if (pkg._target === undefined || pkg._out === undefined) {
                    cb(new PluginError(PACKAGE_NAME, '_target and/or _out undefined.'));
                    return;
                }
                if (err) {
                    cb(new PluginError(PACKAGE_NAME, err, {filename: files[0].path}));
                    return;
                }
                const out = `${pkg._out}/${pkg.package}_${pkg.version}_${pkg.architecture}`;
                installScript('preinst', pkg.preinst, out, cb);
                installScript('postinst', pkg.postinst, out, cb);
                ctrl = ctrl.filter(line => {
                    if (!/Out|Target|Verbose|Changelog|Preinst|Postinst/.test(line)) {
                        return line;
                    }
                });
                const logf = changelog(pkg);
                if (logf.length > 0) {
                    const logp = `${out}/usr/share/doc/${pkg.package}`;
                    const logo = `${logp}/changelog.Debian`;
                    fs.mkdirpSync(logp);
                    fs.outputFile(logo, logf.join('\n'),
                        err => {
                            if (err) {
                                cb(new PluginError(PACKAGE_NAME, err));
                                return;
                            }
                            const gzip = fs.createWriteStream(`${logo}.gz`);
                            const logg = fs.createReadStream(logo);
                            try {
                                logg
                                    .pipe(zlib.createGzip())
                                    .pipe(gzip);
                            } catch (e) {
                                logger.info(logger.colors.red(`Error creating ${gzip} for changelog!`));
                                logger.info(e.stack);
                            } finally {
                                if (fs.existsSync(logo)) {
                                    fs.removeSync(logo);
                                }
                            }
                        });
                }
                const ctrlf = ctrl.join('\n');
                fs.outputFile(`${out}/DEBIAN/control`, ctrlf.substr(0, ctrlf.length - 1),
                    err => {
                        if (err) {
                            cb(new PluginError(PACKAGE_NAME, err));
                            return;
                        }
                        files.map(f => {
                            let t = f.path.split('/');
                            t = t[t.length - 1];
                            fs.copySync(f.path, `${out}/${pkg._target}/${t}`);
                        });
                        exec(`dpkg-deb --build ${pkg._out}/${pkg.package}_${pkg.version}_${pkg.architecture}`,
                            (err, stdout, stderr) => {
                                if (pkg._verbose && stdout.length > 1) {
                                    logger.info(stdout.trim() + '\n');
                                }
                                if (stderr) {
                                    logger.info(logger.colors.red(stderr.trim()));
                                    cb(err);
                                } else {
                                    cb();
                                }
                            });
                    });
            });
        });
}

module.exports = smartDeb;
