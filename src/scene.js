/*global Scene */
import Geo from './geo';
import Utils from './utils/utils';
import WorkerBroker from './utils/worker_broker';
import subscribeMixin from './utils/subscribe';
import Context from './gl/context';
import Texture from './gl/texture';
import VertexArrayObject from './gl/vao';
import {StyleManager} from './styles/style_manager';
import {StyleParser} from './styles/style_parser';
import Camera from './camera';
import Light from './light';
import TileManager from './tile_manager';
import DataSource from './data_source';
import FeatureSelection from './selection';

import {Polygons} from './styles/polygons/polygons';
import {Lines} from './styles/lines/lines';
import {Points} from './styles/points/points';
import {TextStyle} from './styles/text/text';

// Add built-in rendering styles
StyleManager.register(Polygons);
StyleManager.register(Lines);
StyleManager.register(Points);
StyleManager.register(TextStyle);

import log from 'loglevel';
import glMatrix from 'gl-matrix';
let mat4 = glMatrix.mat4;
let mat3 = glMatrix.mat3;
let vec3 = glMatrix.vec3;

// Load scene definition: pass an object directly, or a URL as string to load remotely
export default class Scene {

    constructor(config_source, options) {
        options = options || {};
        subscribeMixin(this);

        this.initialized = false;
        this.initializing = false;
        this.sources = {};

        this.tile_manager = TileManager;
        this.tile_manager.init(this);
        this.num_workers = options.numWorkers || 2;
        this.continuous_zoom = (typeof options.continuousZoom === 'boolean') ? options.continuousZoom : true;
        this.tile_simplification_level = 0; // level-of-detail downsampling to apply to tile loading
        this.allow_cross_domain_workers = (options.allowCrossDomainWorkers === false ? false : true);
        this.worker_url = options.workerUrl;
        if (options.disableVertexArrayObjects === true) {
            VertexArrayObject.disabled = true;
        }

        Utils.use_high_density_display = options.highDensityDisplay !== undefined ? options.highDensityDisplay : true;
        Utils.updateDevicePixelRatio();

        this.config = null;
        this.config_source = config_source;
        this.config_serialized = null;

        this.styles = null;
        this.active_styles = {};

        this.building = null;                           // tracks current scene building state (tiles being built, etc.)
        this.dirty = true;                              // request a redraw
        this.animated = false;                          // request redraw every frame
        this.preUpdate = options.preUpdate;             // optional pre-render loop hook
        this.postUpdate = options.postUpdate;           // optional post-render loop hook
        this.render_loop = !options.disableRenderLoop;  // disable render loop - app will have to manually call Scene.render() per frame
        this.frame = 0;
        this.resetTime();

        this.zoom = null;
        this.center = null;

        this.zooming = false;
        this.preserve_tiles_within_zoom = 1;
        this.panning = false;
        this.container = options.container;

        this.camera = null;
        this.lights = null;
        this.background = null;

        // Model-view matrices
        // 64-bit versions are for CPU calcuations
        // 32-bit versions are downsampled and sent to GPU
        this.modelMatrix = new Float64Array(16);
        this.modelMatrix32 = new Float32Array(16);
        this.modelViewMatrix = new Float64Array(16);
        this.modelViewMatrix32 = new Float32Array(16);
        this.normalMatrix = new Float64Array(9);
        this.normalMatrix32 = new Float32Array(9);

        this.selection = null;
        this.texture_listener = null;

        // Debug config
        this.debug = {
            profile: {
                geometry_build: false
            }
        };

        this.initialized = false;
        this.initializing = false;
        this.updating = 0;
        this.generation = 0; // an id that is incremented each time the scene config is invalidated

        this.logLevel = options.logLevel || 'warn';
        log.setLevel(this.logLevel);
    }

    init() {
        if (this.initialized) {
            return Promise.resolve();
        }
        this.initializing = true;

        // Load scene definition (sources, styles, etc.), then create styles & workers
        return new Promise((resolve, reject) => {
            this.tile_manager.init(this);
            this.loadScene().then(() => {
                this.createWorkers().then(() => {
                    this.createCanvas();
                    this.selection = new FeatureSelection(this.gl, this.workers);

                    this.texture_listener = { update: () => this.dirty = true };
                    Texture.subscribe(this.texture_listener);

                    // Loads rendering styles from config, sets GL context and compiles programs
                    this.updateConfig();

                    this.initializing = false;
                    this.initialized = true;
                    resolve();

                    if (this.render_loop !== false) {
                        this.setupRenderLoop();
                    }
                }).catch(e => reject(e));
            }).catch(e => reject(e));
        });
    }

    destroy() {
        this.initialized = false;
        this.renderLoop = () => {}; // set to no-op because a null can cause requestAnimationFrame to throw

        this.unsubscribeAll(); // clear all event listeners

        Texture.unsubscribe(this.texture_listener);
        this.texture_listener = null;

        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
            this.canvas = null;
        }
        this.container = null;

        if (this.gl) {
            this.gl.deleteFramebuffer(this.fbo);
            this.fbo = null;

            Texture.destroy(this.gl);
            StyleManager.destroy(this.gl);
            this.styles = {};

            this.gl = null;
        }

        this.sources = {};

        if (Array.isArray(this.workers)) {
            this.workers.forEach((worker) => {
                worker.terminate();
            });
            this.workers = null;
        }

        this.tile_manager.destroy();
    }

    createCanvas() {
        this.container = this.container || document.body;
        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = 0;
        this.canvas.style.left = 0;

        // Force tangram canvas underneath all leaflet layers, and set background to transparent
        this.canvas.style.zIndex = -1;
        this.container.style.cssText += 'background: transparent;';
        this.container.appendChild(this.canvas);

        try {
            this.gl = Context.getContext(this.canvas, {
                alpha: false /*premultipliedAlpha: false*/,
                device_pixel_ratio: Utils.device_pixel_ratio
            });
        }
        catch(e) {
            throw new Error(
                "Couldn't create WebGL context. " +
                "Your browser may not support WebGL, or it's turned off? " +
                "Visit http://webglreport.com/ for more info."
            );
        }

        this.resizeMap(this.container.clientWidth, this.container.clientHeight);
        VertexArrayObject.init(this.gl);
    }

    createObjectURL() {
        return (window.URL && window.URL.createObjectURL) || (window.webkitURL && window.webkitURL.createObjectURL);
    }

    loadWorkerUrl(scene) {
        var worker_url = scene.worker_url || Utils.findCurrentURL('tangram.debug.js', 'tangram.min.js'),
            createObjectURL = scene.createObjectURL();

        return new Promise((resolve, reject) => {
            if (!worker_url) {
                reject(new Error("Can't load worker because couldn't find base URL that library was loaded from"));
                return;
            }

            if (createObjectURL && scene.allow_cross_domain_workers) {
                var body = `importScripts('${worker_url}');`;
                var worker_local_url = createObjectURL(new Blob([body], { type: 'application/javascript' }));
                resolve(worker_local_url);
            } else {
                resolve(worker_url);
            }
        });
    }

    // Web workers handle heavy duty tile construction: networking, geometry processing, etc.
    createWorkers() {
        return new Promise((resolve, reject) => {
            this.loadWorkerUrl(this).then((worker_url) => {
                this.makeWorkers(worker_url).then(resolve, reject);
            });
        });
    }

    // Instantiate workers from URL, init event handlers
    makeWorkers(url) {
        var queue = [];

        this.workers = [];
        for (var id=0; id < this.num_workers; id++) {
            var worker = new Worker(url);
            this.workers[id] = worker;

            worker.addEventListener('message', this.workerLogMessage.bind(this));
            WorkerBroker.addWorker(worker);

            log.debug(`Scene.makeWorkers: initializing worker ${id}`);
            let _id = id;
            queue.push(WorkerBroker.postMessage(worker, 'init', id, this.num_workers, Utils.device_pixel_ratio).then(
                (id) => {
                    log.debug(`Scene.makeWorkers: initialized worker ${id}`);
                    return id;
                },
                (error) => {
                    log.error(`Scene.makeWorkers: failed to initialize worker ${_id}:`, error);
                    return Promise.reject(error);
                })
            );
        }

        this.next_worker = 0;
        return Promise.all(queue);
    }

    // Round robin selection of next worker
    nextWorker() {
        var worker = this.workers[this.next_worker];
        this.next_worker = (this.next_worker + 1) % this.workers.length;
        return worker;
    }

    /**
        Set the map view, can be passed an object with lat/lng and/or zoom
    */
    setView({ lng, lat, zoom } = {}) {
        var changed = false;

        // Set center
        if (typeof lng === 'number' && typeof lat === 'number') {
            changed = changed || !this.center || lng !== this.center.lng || lat !== this.center.lat;
            this.center = { lng: Geo.wrapLng(lng), lat };
        }

        // Set zoom
        if (typeof zoom === 'number') {
            changed = changed || zoom !== this.zoom;
            this.setZoom(zoom);
        }

        if (changed) {
            this.updateBounds();
        }
        return changed;
    }

    startZoom() {
        this.last_zoom = this.zoom;
        this.zooming = true;
    }

    // Choose the base zoom level to use for a given fractional zoom
    baseZoom(zoom) {
        return Math.floor(zoom);
    }

    // For a given view zoom, what tile zoom should be loaded?
    tileZoom(view_zoom) {
        return this.baseZoom(view_zoom) - this.tile_simplification_level;
    }

    // For a given tile zoom, what style zoom should be used?
    styleZoom(tile_zoom) {
        return this.baseZoom(tile_zoom) + this.tile_simplification_level;
    }

    setZoom(zoom) {
        this.zooming = false;
        let tile_zoom = this.tileZoom(zoom);

        if (!this.continuous_zoom) {
            zoom = tile_zoom;
        }

        if (tile_zoom !== this.tileZoom(this.last_zoom)) {
            // Remove tiles outside current zoom that are still loading
            this.tile_manager.removeTiles(tile => {
                if (tile.loading && this.tileZoom(tile.coords.z) !== tile_zoom) {
                    log.trace(`removed ${tile.key} (was loading, but outside current zoom)`);
                    return true;
                }
            });
        }

        this.last_zoom = this.zoom;
        this.zoom = zoom;
        this.tile_zoom = tile_zoom;

        this.updateBounds();

        this.dirty = true;
    }

    viewReady() {
        if (this.css_size == null || this.center == null || this.zoom == null || Object.keys(this.sources).length === 0) {
             return false;
        }
        return true;
    }

    // Calculate viewport bounds based on current center and zoom
    updateBounds() {
        // TODO: better concept of "readiness" state?
        if (!this.viewReady()) {
            return;
        }

        this.meters_per_pixel = Geo.metersPerPixel(this.zoom);

        // Size of the half-viewport in meters at current zoom
        this.viewport_meters = {
            x: this.css_size.width * this.meters_per_pixel,
            y: this.css_size.height * this.meters_per_pixel
        };

        // Center of viewport in meters, and tile
        let [x, y] = Geo.latLngToMeters([this.center.lng, this.center.lat]);
        this.center_meters = { x, y };

        let z = this.tileZoom(this.zoom);
        // let max_zoom = this.findMaxZoom();
        // if (z > max_zoom) {
        //     z = max_zoom;
        // }
        this.center_tile = Geo.tileForMeters([this.center_meters.x, this.center_meters.y], z);

        this.bounds_meters = {
            sw: {
                x: this.center_meters.x - this.viewport_meters.x / 2,
                y: this.center_meters.y - this.viewport_meters.y / 2
            },
            ne: {
                x: this.center_meters.x + this.viewport_meters.x / 2,
                y: this.center_meters.y + this.viewport_meters.y / 2
            }
        };

        this.tile_manager.updateTilesForView();

        this.trigger('move');
        this.dirty = true;
    }

    findVisibleTiles({ buffer } = {}) {
        if (this.initialized !== true) {
            return;
        }

        let z = this.tileZoom(this.zoom);
        // let max_zoom = this.findMaxZoom();
        // if (z > max_zoom) {
        //     z = max_zoom;
        // }

        let sw = Geo.tileForMeters([this.bounds_meters.sw.x, this.bounds_meters.sw.y], z);
        let ne = Geo.tileForMeters([this.bounds_meters.ne.x, this.bounds_meters.ne.y], z);
        buffer = buffer || 0;

        // let tiles = {};
        let tiles = [];
        for (let x = sw.x - buffer; x <= ne.x + buffer; x++) {
            for (let y = ne.y - buffer; y <= sw.y + buffer; y++) {
                let coords = { x, y, z };
                tiles.push(coords);
            }
        }
        return tiles;
    }

    // Remove tiles too far outside of view
    pruneTilesForView(border_buffer = 2) {
        if (!this.viewReady()) {
            return;
        }

        // Remove tiles that are a specified # of tiles outside of the viewport border
        let border_tiles = [
            Math.ceil((Math.floor(this.css_size.width / Geo.tile_size) + 2) / 2),
            Math.ceil((Math.floor(this.css_size.height / Geo.tile_size) + 2) / 2)
        ];
        let base = this.tileZoom(this.zoom);

        this.tile_manager.removeTiles(tile => {
            // Ignore visible tiles
            if (tile.visible) {
                return false;
            }

            // Discard if too far from current zoom
            let zdiff = tile.coords.z - base;
            if (Math.abs(zdiff) > this.preserve_tiles_within_zoom) {
                return true;
            }

            // Handle tiles at different zooms
            let ztrans = Math.pow(2, zdiff);
            let coords = {
                x: Math.floor(tile.coords.x / ztrans),
                y: Math.floor(tile.coords.y / ztrans)
            };

            // Discard tiles outside an area surrounding the viewport
            if (Math.abs(coords.x - this.center_tile.x) - border_tiles[0] > border_buffer) {
                log.trace(`Scene: remove tile ${tile.key} (as ${coords.x}/${coords.y}/${base}) for being too far out of visible area ***`);
                return true;
            }
            else if (Math.abs(coords.y - this.center_tile.y) - border_tiles[1] > border_buffer) {
                log.trace(`Scene: remove tile ${tile.key} (as ${coords.x}/${coords.y}/${base}) for being too far out of visible area ***`);
                return true;
            }
            return false;
        });
    }

    resizeMap(width, height) {
        this.dirty = true;

        this.css_size = { width: width, height: height };
        this.device_size = {
            width: Math.round(this.css_size.width * Utils.device_pixel_ratio),
            height: Math.round(this.css_size.height * Utils.device_pixel_ratio)
        };
        this.view_aspect = this.css_size.width / this.css_size.height;
        this.updateBounds();

        if (this.canvas) {
            this.canvas.style.width = this.css_size.width + 'px';
            this.canvas.style.height = this.css_size.height + 'px';
            this.canvas.width = this.device_size.width;
            this.canvas.height = this.device_size.height;

            if (this.gl) {
                this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
                this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            }
        }
    }

    // Request scene be redrawn at next animation loop
    requestRedraw() {
        this.dirty = true;
    }

    // Redraw scene immediately - don't wait for animation loop
    // Use sparingly, but for cases where you need the closest possible sync with other UI elements,
    // such as other, non-WebGL map layers (e.g. Leaflet raster layers, markers, etc.)
    immediateRedraw() {
        this.dirty = true;
        this.render();
    }

    // Setup the render loop
    setupRenderLoop({ pre_render, post_render } = {}) {
        this.renderLoop = () => {
            if (this.initialized) {
                // Render the scene
                this.update();
            }

            // Request the next frame
            window.requestAnimationFrame(this.renderLoop);
        };
        setTimeout(() => { this.renderLoop(); }, 0); // delay start by one tick
    }

    update() {
        this.tile_manager.loadQueuedTileCoordinates();

        // Render on demand
        var will_render = !(
            this.dirty === false ||
            this.initialized === false ||
            this.updating > 0 ||
            this.viewReady() === false
        );

        // Pre-render loop hook
        if (typeof this.preUpdate === 'function') {
            this.preUpdate(will_render);
        }

        // Bail if no need to render
        if (!will_render) {
            return false;
        }
        this.dirty = false; // subclasses can set this back to true when animation is needed

        // Render the scene
        this.render();

        // Post-render loop hook
        if (typeof this.postUpdate === 'function') {
            this.postUpdate(will_render);
        }

        // Redraw every frame if animating
        if (this.animated === true) {
            this.dirty = true;
        }

        this.frame++;
        log.trace('Scene.render()');
        return true;
    }

    render() {
        var gl = this.gl;

        // Map transforms
        if (!this.center_meters) {
            return;
        }

        // Update styles, camera, lights
        this.camera.update();
        Object.keys(this.active_styles).forEach(i => this.styles[i].update());
        Object.keys(this.lights).forEach(i => this.lights[i].update());

        // Renderable tile list
        this.renderable_tiles = this.tile_manager.getRenderableTiles();
        this.renderable_tiles_count = this.renderable_tiles.length;

        // Render main pass
        this.render_count = this.renderPass();

        // Render selection pass (if needed)
        if (this.selection.pendingRequests()) {
            if (this.panning) {
                return;
            }

            this.selection.bind();                  // switch to FBO
            this.renderPass(
                'selection_program',                // render w/alternate program
                { allow_alpha_blend: false });
            this.selection.read();                  // read results from selection buffer

            // Reset to screen buffer
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        }

        if (this.render_count !== this.last_render_count) {
            this.getFeatureSelectionMapSize().then(size => {
                log.info(`Scene: rendered ${this.render_count} primitives (${size} features in selection map)`);
            });
        }
        this.last_render_count = this.render_count;

        return true;
    }

    // Render all active styles, grouped by blend/depth type (opaque, overlay, etc.) and by program (style)
    // Called both for main render pass, and for secondary passes like selection buffer
    renderPass(program_key = 'program', { allow_alpha_blend } = {}) {
        let styles;
        let count = 0; // how many primitives were rendered

        // optionally force alpha off (e.g. for selection pass)
        allow_alpha_blend = (allow_alpha_blend == null) ? true : allow_alpha_blend;

        this.clearFrame({ clear_color: true, clear_depth: true });

        // Opaque styles: depth test on, depth write on, blending off
        styles = Object.keys(this.active_styles).filter(s => this.styles[s].blend === 'opaque');
        this.setRenderState({ depth_test: true, depth_write: true, alpha_blend: false });
        count += this.renderStyles(styles, program_key);

        // Transparent styles: depth test off, depth write on, custom blending
        styles = Object.keys(this.active_styles).filter(s => this.styles[s].blend === 'add');
        this.setRenderState({ depth_test: true, depth_write: false, alpha_blend: (allow_alpha_blend && 'add') });
        count += this.renderStyles(styles, program_key);

        styles = Object.keys(this.active_styles).filter(s => this.styles[s].blend === 'multiply');
        this.setRenderState({ depth_test: true, depth_write: false, alpha_blend: (allow_alpha_blend && 'multiply') });
        count += this.renderStyles(styles, program_key);

        // Overlay styles: depth test off, depth write off, blending on
        styles = Object.keys(this.styles).filter(s => this.styles[s].blend === 'overlay');
        this.setRenderState({ depth_test: false, depth_write: false, alpha_blend: allow_alpha_blend });
        count += this.renderStyles(styles, program_key);

        return count;
    }

    renderStyles(styles, program_key) {
        let count = 0;
        for (let style of styles) {
            let program = this.styles[style][program_key];
            if (!program || !program.compiled) {
                continue;
            }
            count += this.renderStyle(style, program);
        }
        return count;
    }

    renderStyle(style, program) {
        var first_for_style = true;
        var render_count = 0;

        // Render tile GL geometries
        for (var t in this.renderable_tiles) {
            var tile = this.renderable_tiles[t];

            if (tile.meshes[style] != null) {
                // Setup style if encountering for first time this frame
                // (lazy init, not all styles will be used in all screen views; some styles might be defined but never used)
                if (first_for_style === true) {
                    first_for_style = false;

                    program.use();
                    this.styles[style].setup();

                    // TODO: don't set uniforms when they haven't changed
                    program.uniform('2f', 'u_resolution', this.device_size.width, this.device_size.height);
                    program.uniform('1f', 'u_time', ((+new Date()) - this.start_time) / 1000);
                    program.uniform('3f', 'u_map_position', this.center_meters.x, this.center_meters.y, this.zoom);
                    // Math.floor(this.zoom) + (Math.log((this.zoom % 1) + 1) / Math.LN2 // scale fractional zoom by log
                    program.uniform('1f', 'u_meters_per_pixel', this.meters_per_pixel);
                    program.uniform('1f', 'u_device_pixel_ratio', Utils.device_pixel_ratio);

                    this.camera.setupProgram(program);
                    for (let i in this.lights) {
                        this.lights[i].setupProgram(program);
                    }
                }

                // TODO: calc these once per tile (currently being needlessly re-calculated per-tile-per-style)

                // Tile origin
                program.uniform('3f', 'u_tile_origin', tile.min.x, tile.min.y, tile.style_zoom);

                // Model matrix - transform tile space into world space (meters, absolute mercator position)
                mat4.identity(this.modelMatrix);
                mat4.translate(this.modelMatrix, this.modelMatrix, vec3.fromValues(tile.min.x, tile.min.y, 0));
                mat4.scale(this.modelMatrix, this.modelMatrix, vec3.fromValues(tile.span.x / Geo.tile_scale, -1 * tile.span.y / Geo.tile_scale, 1)); // scale tile local coords to meters
                mat4.copy(this.modelMatrix32, this.modelMatrix);
                program.uniform('Matrix4fv', 'u_model', false, this.modelMatrix32);

                // Model view matrix - transform tile space into view space (meters, relative to camera)
                mat4.multiply(this.modelViewMatrix32, this.camera.viewMatrix, this.modelMatrix);
                program.uniform('Matrix4fv', 'u_modelView', false, this.modelViewMatrix32);

                // Normal matrix - transforms surface normals into view space
                mat3.normalFromMat4(this.normalMatrix32, this.modelViewMatrix32);
                program.uniform('Matrix3fv', 'u_normalMatrix', false, this.normalMatrix32);

                // Render tile
                tile.meshes[style].render();
                render_count += tile.meshes[style].geometry_count;
            }
        }

        return render_count;
    }

    clearFrame({ clear_color, clear_depth } = {}) {
        if (!this.initialized) {
            return;
        }

        // Defaults
        clear_color = (clear_color === false) ? false : true; // default true
        clear_depth = (clear_depth === false) ? false : true; // default true

        // Reset frame state
        let gl = this.gl;

        if (clear_color) {
            gl.clearColor(...this.background.color);
        }

        if (clear_depth) {
            gl.depthMask(true); // always clear depth if requested, even if depth write will be turned off
        }

        if (clear_color || clear_depth) {
            let mask = (clear_color && gl.COLOR_BUFFER_BIT) | (clear_depth && gl.DEPTH_BUFFER_BIT);
            gl.clear(mask);
        }
    }

    setRenderState({ depth_test, depth_write, cull_face, alpha_blend } = {}) {
        if (!this.initialized) {
            return;
        }

        // Defaults
        // TODO: when we abstract out support for multiple render passes, these can be per-pass config options
        depth_test = (depth_test === false) ? false : true;         // default true
        depth_write = (depth_write === false) ? false : true;       // default true
        cull_face = (cull_face === false) ? false : true;           // default true
        alpha_blend = (alpha_blend != null) ? alpha_blend : false;  // default false

        // Reset frame state
        let gl = this.gl;

        if (depth_test) {
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LEQUAL);
        }
        else {
            gl.disable(gl.DEPTH_TEST);
        }

        gl.depthMask(depth_write);

        if (cull_face) {
            gl.enable(gl.CULL_FACE);
            gl.cullFace(gl.BACK);
        }
        else {
            gl.disable(gl.CULL_FACE);
        }

        if (alpha_blend) {
            gl.enable(gl.BLEND);

            // Traditional blending
            if (alpha_blend === true) {
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            }
            // Additive blending
            else if (alpha_blend === 'add') {
                gl.blendFunc(gl.ONE, gl.ONE);
            }
            // Multiplicative blending
            else if (alpha_blend === 'multiply') {
                gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
            }
        }
        else {
            gl.disable(gl.BLEND);
        }
    }

    // Request feature selection at given pixel. Runs async and returns results via a promise.
    getFeatureAt(pixel) {
        if (!this.initialized) {
            return Promise.reject(new Error("Scene.getFeatureAt() called before scene was initialized"));
        }

        // Point scaled to [0..1] range
        var point = {
            x: pixel.x * Utils.device_pixel_ratio / this.device_size.width,
            y: pixel.y * Utils.device_pixel_ratio / this.device_size.height
        };

        this.dirty = true; // need to make sure the scene re-renders for these to be processed
        return this.selection.getFeatureAt(point);
    }

    findMaxZoom() {
        var max_zoom = this.max_zoom || Geo.max_zoom;

        // for (var name in this.sources) {
        //     let source = this.sources[name];
        //     if (source.max_zoom < max_zoom) {
        //         max_zoom = source.max_zoom;
        //     }
        // }
        return max_zoom;
    }

    // Rebuild geometry, without re-parsing the config or re-compiling styles
    // TODO: detect which elements need to be refreshed/rebuilt (stylesheet changes, etc.)
    rebuild() {
        return this.rebuildGeometry();
    }

    // Rebuild all tiles
    rebuildGeometry() {
        return new Promise((resolve, reject) => {
            // Skip rebuild if already in progress
            if (this.building) {
                // Queue up to one rebuild call at a time, only save last request
                if (this.building.queued && this.building.queued.reject) {
                    // notify previous request that it did not complete
                    log.debug('Scene.rebuildGeometry: request superceded by a newer call');
                    this.building.queued.resolve(false); // false flag indicates rebuild request was superceded
                }

                // Save queued request
                this.building.queued = { resolve, reject };
                log.trace(`Scene.rebuildGeometry(): queuing request`);
                return;
            }

            // Track tile build state
            this.building = { resolve, reject };

            // Profiling
            if (this.debug.profile.geometry_build) {
                this._profile('rebuildGeometry');
            }

            // Update config (in case JS objects were manipulated directly)
            this.syncConfigToWorker();
            StyleManager.compile(this.updateActiveStyles()); // only recompile newly active styles
            this.resetFeatureSelection();
            this.resetTime();

            // Rebuild visible tiles, sorted from center
            let build = [];
            this.tile_manager.forEachTile((tile) => {
                if (tile.visible) {
                    build.push(tile);
                }
                else {
                    this.tile_manager.removeTile(tile.key);
                }
            });
            this.tile_manager.buildTiles(build);
        }).then(() => {
            // Profiling
            if (this.debug.profile.geometry_build) {
                this._profileEnd('rebuildGeometry');
            }
        });
    }

    // Tile manager finished building tiles
    tileManagerBuildDone() {
        if (this.building) {
            log.info(`Scene: build geometry finished`);
            if (this.building.resolve) {
                this.building.resolve(true);
            }

            // Another rebuild queued?
            var queued = this.building.queued;
            this.building = null;
            if (queued) {
                log.debug(`Scene: starting queued rebuildGeometry() request`);
                this.rebuildGeometry().then(queued.resolve, queued.reject);
            }
        }
    }

    /**
       Load (or reload) the scene config
       @return {Promise}
    */
    loadScene() {
        this.config_path = (typeof this.config_source === 'string') && Utils.pathForURL(this.config_source);
        Texture.base_url = this.config_path;

        return Utils.loadResource(this.config_source).then((config) => {
            this.config = config;
            return this.preProcessConfig().then(() => { this.trigger('loadScene', this.config); });
        }).catch(e => {
            throw new Error(`Error loading scene file '${this.config_source}': ${e.message}`);
        });
    }

    // Reload scene config and rebuild tiles
    // Optionally specify new scene file URL
    reload(config_source = null) {
        if (!this.initialized) {
            return Promise.resolve(this);
        }

        // Remove tiles before rebuilding
        this.tile_manager.removeTiles(tile => !tile.visible);

        this.updating++;
        this.initialized = false;
        this.initializing = true;

        this.config_source = config_source || this.config_source;

        return this.loadScene().then(() => {
            this.updateConfig();
            this.syncConfigToWorker();
            return this.rebuildGeometry().then(() => {
                this.updating--;
                this.initialized = true;
                this.initializing = false;
                return this;
            });
        }, (error) => {
            this.initialized = true;
            this.initializing = false;
            this.updating--;
            throw error;
        });
    }

    loadDataSources() {
        for (var name in this.config.sources) {
            let source = this.config.sources[name];
            source.url = Utils.addBaseURL(source.url);
            this.sources[name] = DataSource.create(Object.assign({}, source, {name}));
        }
        this.updateBounds();
    }

    setSourceMax() {
        // let max_zoom = this.findMaxZoom();

        // for (var name in this.sources) {
        //     let source = this.sources[name];
        //     source.max_zoom = max_zoom;
        // }
        // return max_zoom;
    }

    // Normalize some settings that may not have been explicitly specified in the scene definition
    preProcessConfig() {
        // Assign ids to data sources
        let source_id = 0;
        for (let source in this.config.sources) {
            this.config.sources[source].id = source_id++;
        }

        // If only one camera specified, set it as default
        this.config.cameras = this.config.cameras || {};
        if (this.config.camera) {
            this.config.cameras.default = this.config.camera;
        }
        let camera_names = Object.keys(this.config.cameras);
        if (camera_names.length === 0) {
            this.config.cameras.default = { active: true };

        }
        else if (!this._active_camera) {
            // If no camera set as active, use first one
            this.config.cameras[camera_names[0]].active = true;
        }

        this.config.lights = this.config.lights || {}; // ensure lights object
        this.config.styles = this.config.styles || {}; // ensure styles object

        return StyleManager.preload(this.config.styles, this.config_path);
    }

    // Load all textures in the scene definition
    loadTextures() {
        this.normalizeTextures();
        return Texture.createFromObject(this.gl, this.config.textures);
    }

    // Handle single or multi-texture syntax, for stylesheet convenience
    normalizeTextures() {
        if (!this.config.styles) {
            return;
        }

        for (let [style_name, style] of Utils.entries(this.config.styles)) {
            // If style has a single 'texture' object, move it to the global scene texture set
            // and give it a default name
            if (style.texture && typeof style.texture === 'object') {
                let texture_name = '__' + style_name;
                this.config.textures = this.config.textures || {};
                this.config.textures[texture_name] = style.texture;
                style.texture = texture_name; // point stlye to location of texture
            }
        }
    }

    // Called (currently manually) after styles are updated in stylesheet
    updateStyles() {
        if (!this.initialized && !this.initializing) {
            throw new Error('Scene.updateStyles() called before scene was initialized');
        }

        // (Re)build styles from config
        StyleManager.init();
        this.styles = StyleManager.build(this.config.styles, this);

        // Optionally set GL context (used when initializing or re-initializing GL resources)
        for (var style of Utils.values(this.styles)) {
            style.setGL(this.gl);
        }

        // Find & compile active styles
        this.updateActiveStyles();
        StyleManager.compile(Object.keys(this.active_styles));

        this.dirty = true;
    }

    updateActiveStyles() {
        // Make a set of currently active styles (used in a draw rule)
        // Note: doesn't actually check if any geometry matches the rule, just that the style is potentially renderable
        let prev_styles = Object.keys(this.active_styles || {});
        this.active_styles = {};
        var animated = false; // is any active style animated?
        for (var rule of Utils.recurseValues(this.config.layers)) {
            if (rule.draw) {
                for (let [name, group] of Utils.entries(rule.draw)) {
                    // TODO: warn on non-object draw group
                    if (typeof group === 'object' && group.visible !== false) {
                        let style_name = group.style || name;
                        let styles = [style_name];

                        // optional additional outline style
                        if (group.outline && group.outline.style) {
                            styles.push(group.outline.style);
                        }

                        styles = styles.filter(x => this.styles[x]).forEach(style_name => {
                            let style = this.styles[style_name];
                            if (style) {
                                this.active_styles[style_name] = true;
                                if (style.animated) {
                                    animated = true;
                                }
                            }
                        });
                    }
                }
            }
        }

        // Use explicitly set scene animation flag if defined, otherwise turn on animation
        // if there are any animated styles
        this.animated = this.config.scene.animated !== undefined ? this.config.scene.animated : animated;

        // Compile newly active styles
        return Object.keys(this.active_styles).filter(s => prev_styles.indexOf(s) === -1);
    }

    // Create camera
    createCamera() {
        this.camera = Camera.create(this._active_camera, this, this.config.cameras[this._active_camera]);

        // TODO: replace this and move all position info to camera
        this.camera.updateScene();
    }

    // Get active camera - for public API
    getActiveCamera() {
        return this._active_camera;
    }

    // Set active camera and recompile - for public API
    setActiveCamera(name) {
        this._active_camera = name;
        this.updateConfig();
        return this._active_camera;
    }

    // Internal management of active camera
    get _active_camera() {
        for (var name in this.config.cameras) {
            if (this.config.cameras[name].active) {
                return name;
            }
        }
    }

    set _active_camera(name) {
        var prev = this._active_camera;

        // Set new active camera
        if (this.config.cameras[name]) {
            this.config.cameras[name].active = true;

            // Clear previously active camera
            if (prev && prev !== name && this.config.cameras[prev]) {
                delete this.config.cameras[prev].active;
            }
        }
    }

    // Create lighting
    createLights() {
        this.lights = {};
        for (let i in this.config.lights) {
            this.config.lights[i].name = i;
            this.config.lights[i].visible = (this.config.lights[i].visible === false) ? false : true;
            if (this.config.lights[i].visible) {
                this.lights[i] = Light.create(this, this.config.lights[i]);
            }
        }
        Light.inject(this.lights);
    }

    // Set background color
    setBackground() {
        let bg = this.config.scene.background;
        this.background = {};
        if (bg && bg.color) {
            this.background.color = StyleParser.parseColor(bg.color);
        }
        if (!this.background.color) {
            this.background.color = [0, 0, 0, 1]; // default background to black
        }
    }

    // Update scene config, and optionally rebuild geometry
    updateConfig({ rebuild } = {}) {
        this.generation++;
        this.updating++;
        this.config.scene = this.config.scene || {};
        this.createCamera();
        this.createLights();
        this.loadDataSources();
        this.setSourceMax();
        this.loadTextures();
        this.setBackground();

        // TODO: detect changes to styles? already (currently) need to recompile anyway when camera or lights change
        this.updateStyles();
        this.syncConfigToWorker();
        if (rebuild) {
            return this.rebuildGeometry().then(() => this.updating--);
        }
        else {
            this.updating--;
            return Promise.resolve();
        }
    }

    // Serialize config and send to worker
    syncConfigToWorker() {
        // Tell workers we're about to rebuild (so they can update styles, etc.)
        this.config_serialized = Utils.serializeWithFunctions(this.config);
        this.workers.forEach(worker => {
            WorkerBroker.postMessage(worker, 'updateConfig', {
                config: this.config_serialized,
                generation: this.generation
            });
        });
    }

    resetFeatureSelection() {
        this.workers.forEach(worker => WorkerBroker.postMessage(worker, 'resetFeatureSelection'));
    }

    // Gets the current feature selection map size across all workers. Returns a promise.
    getFeatureSelectionMapSize() {
        return Promise
            .all(this.workers.map(worker => WorkerBroker.postMessage(worker, 'getFeatureSelectionMapSize')))
            .then(sizes => sizes.reduce((a, b) => a + b));
    }

    // Reset internal clock, mostly useful for consistent experience when changing styles/debugging
    resetTime() {
        this.start_time = +new Date();
    }


    // Stats/debug/profiling methods

    // Sum of a debug property across tiles
    getDebugSum(prop, filter) {
        var sum = 0;
        for (var t in this.tiles) {
            if (this.tiles[t].debug[prop] != null && (typeof filter !== 'function' || filter(this.tiles[t]) === true)) {
                sum += this.tiles[t].debug[prop];
            }
        }
        return sum;
    }

    // Average of a debug property across tiles
    getDebugAverage(prop, filter) {
        return this.getDebugSum(prop, filter) / Object.keys(this.tiles).length;
    }

    // Log messages pass through from web workers
    workerLogMessage(event) {
        if (event.data.type !== 'log') {
            return;
        }

        var { worker_id, level, msg } = event.data;

        if (log[level]) {
            log[level](`worker ${worker_id}:`,  ...msg);
        }
        else {
            log.error(`Scene.workerLogMessage: unrecognized log level ${level}`);
        }
    }

    // Profile helpers, issues a profile on main thread & all workers
    _profile(name) {
        console.profile(`main thread: ${name}`);
        this.workers.forEach(w => WorkerBroker.postMessage(w, 'profile', name));
    }

    _profileEnd(name) {
        console.profileEnd(`main thread: ${name}`);
        this.workers.forEach(w => WorkerBroker.postMessage(w, 'profileEnd', name));
    }

}

// Static methods/state

Scene.create = function (config, options = {}) {
    return new Scene(config, options);
};
