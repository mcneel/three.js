import {
	ClampToEdgeWrapping,
	Color,
	DefaultLoadingManager,
	FileLoader,
	Matrix3,
	Matrix4,
	Vector3
} from 'three';

const _v = /*@__PURE__*/ new Vector3();
const _n = /*@__PURE__*/ new Vector3();
const _a = /*@__PURE__*/ new Vector3();
const _b = /*@__PURE__*/ new Vector3();
const _m = /*@__PURE__*/ new Matrix4();
const _m3 = /*@__PURE__*/ new Matrix3();

/**
 * An exporter for Rhinoceros 3D files (`.3dm`).
 *
 * The exporter writes meshes, points, lines (wide lines too), lights, instanced and batched meshes,
 * together with their materials and textures (embedded as PNG). Cameras become named views, and a
 * scene's background color becomes the render background. The object hierarchy
 * becomes Rhino's layer tree, and `userData` becomes user strings; content loaded with
 * {@link Rhino3dmLoader} keeps its original layers. Skinned meshes are written in their current
 * pose, optionally with their skeleton as lines.
 *
 * The exporter uses [rhino3dm.js](https://www.npmjs.com/package/rhino3dm) to write the file, in a
 * Web Worker. Like {@link Rhino3dmLoader}, it needs the path to the library files.
 *
 * ```js
 * const exporter = new Rhino3dmExporter();
 * exporter.setLibraryPath( 'https://cdn.jsdelivr.net/npm/rhino3dm@9.2.0-beta.1/' );
 * const data = await exporter.parseAsync( scene );
 * ```
 *
 * @three_import import { Rhino3dmExporter } from 'three/addons/exporters/3DMExporter.js';
 */
class Rhino3dmExporter {

	/**
	 * Constructs a new Rhino 3DM exporter.
	 *
	 * @param {LoadingManager} [manager] - The loading manager, used to load rhino3dm.js.
	 */
	constructor( manager = DefaultLoadingManager ) {

		this.manager = manager;
		this.libraryPath = '';
		this.library = null;

		this.workerPending = null;
		this.worker = null;
		this.workerSourceURL = '';
		this.requests = new Map();
		this.requestId = 0;

	}

	/**
	 * Path to a folder containing the JS and WASM libraries.
	 *
	 * @param {string} path - The library path to set.
	 * @return {Rhino3dmExporter} A reference to this exporter.
	 */
	setLibraryPath( path ) {

		this.libraryPath = path;

		return this;

	}

	/**
	 * Uses an rhino3dm.js module that is already initialized, instead of loading one. The file is
	 * then written on the calling thread, not in a worker (for Node.js, or a worker of your own).
	 *
	 * @param {Object} rhino - The rhino3dm.js module.
	 * @return {Rhino3dmExporter} A reference to this exporter.
	 */
	setLibrary( rhino ) {

		this.library = rhino;

		return this;

	}

	/**
	 * Parses the given 3D object and generates the 3DM output.
	 *
	 * @param {Object3D} input - The 3D object to export.
	 * @param {Rhino3dmExporter~OnDone} onDone - A callback function that is executed when the export has finished.
	 * @param {Rhino3dmExporter~OnError} onError - A callback function that is executed when an error happens.
	 * @param {Rhino3dmExporter~Options} [options] - The export options.
	 */
	parse( input, onDone, onError, options ) {

		this.parseAsync( input, options ).then( onDone ).catch( onError );

	}

	/**
	 * Async version of {@link Rhino3dmExporter#parse}.
	 *
	 * @async
	 * @param {Object3D} input - The 3D object to export.
	 * @param {Rhino3dmExporter~Options} [options] - The export options.
	 * @return {Promise<Uint8Array>} A Promise that resolves with the 3DM file's bytes.
	 */
	async parseAsync( input, options = {} ) {

		options = Object.assign( {
			onlyVisible: true,
			rotateFromYUp: false,
			skeletons: true,
			units: '',
			version: 8
		}, options );

		const { data, transfer } = await new Collector( options ).collect( input );

		if ( this.library !== null ) return write3dm( this.library, data );

		await this._initWorker();

		return new Promise( ( resolve, reject ) => {

			const id = this.requestId ++;
			this.requests.set( id, { resolve, reject } );
			this.worker.postMessage( { type: 'write', id, data }, transfer );

		} );

	}

	/**
	 * Terminates the worker. Call it when the exporter is no longer needed.
	 */
	dispose() {

		if ( this.worker !== null ) this.worker.terminate();
		if ( this.workerSourceURL !== '' ) URL.revokeObjectURL( this.workerSourceURL );

		for ( const request of this.requests.values() ) request.reject( new Error( 'THREE.Rhino3dmExporter: disposed.' ) );

		this.workerPending = null;
		this.worker = null;
		this.workerSourceURL = '';
		this.requests.clear();

	}

	_initWorker() {

		if ( this.workerPending === null ) {

			const jsLoader = new FileLoader( this.manager );
			jsLoader.setPath( this.libraryPath );

			const binaryLoader = new FileLoader( this.manager );
			binaryLoader.setPath( this.libraryPath );
			binaryLoader.setResponseType( 'arraybuffer' );

			this.workerPending = Promise.all( [
				jsLoader.loadAsync( 'rhino3dm.js' ),
				binaryLoader.loadAsync( 'rhino3dm.wasm' )
			] ).then( ( [ jsContent, binaryContent ] ) => {

				const fn = Rhino3dmExporterWorker.toString();

				const body = [
					'/* rhino3dm.js */',
					jsContent,
					'/* writer */',
					write3dm.toString(),
					'/* worker */',
					fn.substring( fn.indexOf( '{' ) + 1, fn.lastIndexOf( '}' ) )
				].join( '\n' );

				this.workerSourceURL = URL.createObjectURL( new Blob( [ body ] ) );
				this.worker = new Worker( this.workerSourceURL );

				this.worker.onmessage = ( event ) => {

					const message = event.data;
					const request = this.requests.get( message.id );
					if ( request === undefined ) return;

					this.requests.delete( message.id );

					if ( message.type === 'done' ) request.resolve( message.bytes );
					else request.reject( new Error( 'THREE.Rhino3dmExporter: ' + message.error ) );

				};

				this.worker.onerror = ( event ) => {

					for ( const request of this.requests.values() ) request.reject( new Error( 'THREE.Rhino3dmExporter: ' + event.message ) );
					this.requests.clear();

				};

				this.worker.postMessage( { type: 'init', wasmBinary: binaryContent } );

			} ).catch( ( error ) => {

				// a failed load (a wrong library path) is tried again on the next export
				this.workerPending = null;
				throw error;

			} );

		}

		return this.workerPending;

	}

}

// Collects what the file holds from the scene, as plain data: numbers, strings and typed arrays, which
// go to the worker without copying. Everything that needs three.js or the page (matrices, canvases) is done here.

class Collector {

	constructor( options ) {

		this.options = options;

		// three.js world coordinates to Rhino's
		this.axes = new Matrix4();
		if ( options.rotateFromYUp ) this.axes.set( 1, 0, 0, 0, 0, 0, - 1, 0, 0, 1, 0, 0, 0, 0, 0, 1 ); // exact: makeRotationX() leaves 1e-17s
		this.axes3 = new Matrix3().setFromMatrix4( this.axes );

		this.layerIndices = new Map(); // Object3D -> layer index
		this.layerNames = new Map(); // parent layer index -> Set of child names
		this.materialIndices = new Map(); // material uuid -> material index
		this.fileGroups = new Map(); // Rhino3dmLoader group index -> group index
		this.blockNames = new Set();
		this.viewNames = new Set();
		this.warnings = new Set();

		this.data = { version: options.version, units: options.units, images: [], layers: [], materials: [], groups: 0, blocks: [], objects: [], views: [], strings: [] };
		this.transfer = [];

	}

	async collect( input ) {

		const objects = [];

		const visit = ( object ) => {

			if ( this.options.onlyVisible && object.visible === false ) return;

			objects.push( object );

			for ( const child of object.children ) visit( child );

		};

		visit( input );

		// texture images first: encoding them is the asynchronous part
		this.images = await this.encodeImages( objects );

		for ( const image of this.images.values() ) {

			if ( image.bytes === null ) continue;

			this.data.images.push( { fileName: image.fileName, bytes: image.bytes } );
			this.transfer.push( image.bytes.buffer );

		}

		// updateMatrixWorld(), not updateWorldMatrix(): SkinnedMesh updates its bindMatrixInverse there
		input.updateWorldMatrix( true, false );
		input.updateMatrixWorld( true );
		this.root = input;

		if ( input.userData.objectType === 'File3dm' && Array.isArray( input.userData.layers ) ) this.collectFileLayers( input.userData.layers );

		// the document's user strings, as Rhino3dmLoader reads them: [ key, value ] pairs
		if ( input.userData.objectType === 'File3dm' && Array.isArray( input.userData.strings ) ) this.data.strings = userStringPairs( input.userData.strings );

		if ( input.isScene && input.background !== null ) {

			if ( input.background.isColor ) this.data.background = toColor( input.background );
			else this.warn( 'Only a color scene background is written.' );

		}

		for ( const object of objects ) this.collectObject( object );

		return { data: this.data, transfer: this.transfer };

	}

	collectObject( object ) {

		if ( object.isSkinnedMesh ) {

			this.collectMesh( object, true );
			if ( this.options.skeletons ) this.collectSkeleton( object );

		} else if ( object.isInstancedMesh ) {

			this.collectInstancedMesh( object );

		} else if ( object.isBatchedMesh ) {

			this.collectBatchedMesh( object );

		} else if ( object.isLineSegments2 ) {

			// Line2 too
			this.collectWideLine( object );

		} else if ( object.isMesh ) {

			this.collectMesh( object, object.morphTargetInfluences !== undefined && object.geometry.morphAttributes.position !== undefined );

		} else if ( object.isPoints ) {

			this.collectPoints( object );

		} else if ( object.isLine ) {

			this.collectLine( object );

		} else if ( object.isLight ) {

			this.collectLight( object );

		} else if ( object.isPerspectiveCamera || object.isOrthographicCamera ) {

			this.collectCamera( object );

		} else if ( object.isSprite ) {

			this.warn( 'Sprite is not supported yet.' );

		}

	}

	// Meshes

	collectMesh( object, deformed ) {

		const geometry = object.geometry;
		if ( geometry.getAttribute( 'position' ) === undefined ) return;

		if ( deformed && object.isSkinnedMesh ) {

			for ( const bone of object.skeleton.bones ) bone.updateWorldMatrix( true, false );

		}

		const matrix = _m.multiplyMatrices( this.axes, object.matrixWorld );
		const buffers = this.meshBuffers( object, matrix, deformed );
		const parts = this.meshParts( object ).map( ( part ) => {

			const attributes = this.attributes( object );
			this.setMaterial( attributes, part.material );
			return { index: part.index, attributes };

		} );

		if ( parts.length > 0 ) this.data.objects.push( { type: 'mesh', buffers, parts } );

	}

	// Vertex buffers in Rhino's coordinates, of `count` vertices from `start`. A deformed mesh (skinned or morphed)
	// is written in its current pose, without its normals: Rhino computes them.

	meshBuffers( object, matrix, deformed, start = 0, count = object.geometry.getAttribute( 'position' ).count - start ) {

		const geometry = object.geometry;
		const position = geometry.getAttribute( 'position' );
		const normal = geometry.getAttribute( 'normal' );
		const uv = geometry.getAttribute( 'uv' );
		const color = geometry.getAttribute( 'color' );
		const material = Array.isArray( object.material ) ? object.material[ 0 ] : object.material;

		const buffers = { position: new Float32Array( count * 3 ) };

		for ( let i = 0; i < count; i ++ ) {

			if ( deformed ) object.getVertexPosition( start + i, _v );
			else _v.fromBufferAttribute( position, start + i );

			_v.applyMatrix4( matrix ).toArray( buffers.position, i * 3 );

		}

		if ( normal !== undefined && ! deformed ) {

			const normalMatrix = _m3.getNormalMatrix( matrix );
			buffers.normal = new Float32Array( count * 3 );

			for ( let i = 0; i < count; i ++ ) {

				_n.fromBufferAttribute( normal, start + i ).applyMatrix3( normalMatrix ).normalize().toArray( buffers.normal, i * 3 );

			}

		}

		if ( uv !== undefined ) {

			buffers.uv = new Float32Array( count * 2 );

			for ( let i = 0; i < count; i ++ ) {

				buffers.uv[ i * 2 ] = uv.getX( start + i );
				buffers.uv[ i * 2 + 1 ] = uv.getY( start + i );

			}

		}

		if ( color !== undefined && material.vertexColors !== false ) {

			buffers.color = new Float32Array( count * 3 );

			for ( let i = 0; i < count; i ++ ) {

				buffers.color[ i * 3 ] = color.getX( start + i );
				buffers.color[ i * 3 + 1 ] = color.getY( start + i );
				buffers.color[ i * 3 + 2 ] = color.getZ( start + i );

			}

		}

		for ( const name in buffers ) this.transfer.push( buffers[ name ].buffer );

		return buffers;

	}

	// The triangles of each material: a Rhino mesh has one material, so a mesh with geometry groups is split.

	meshParts( object ) {

		const geometry = object.geometry;
		const index = geometry.index;
		const total = index !== null ? index.count : geometry.getAttribute( 'position' ).count;

		const drawStart = Math.max( 0, geometry.drawRange.start );
		const drawEnd = Math.min( total, drawStart + geometry.drawRange.count );

		const ranges = Array.isArray( object.material ) && geometry.groups.length > 0
			? geometry.groups.map( ( group ) => ( { start: group.start, end: group.start + group.count, material: object.material[ group.materialIndex ] } ) )
			: [ { start: 0, end: total, material: Array.isArray( object.material ) ? object.material[ 0 ] : object.material } ];

		const parts = [];

		for ( const range of ranges ) {

			const start = Math.max( range.start, drawStart );
			const end = Math.min( range.end, drawEnd );
			const count = Math.floor( ( end - start ) / 3 ) * 3;
			if ( count <= 0 || range.material === undefined ) continue;

			const partIndex = new Uint32Array( count );
			for ( let i = 0; i < count; i ++ ) partIndex[ i ] = index !== null ? index.getX( start + i ) : start + i;

			this.transfer.push( partIndex.buffer );
			parts.push( { index: partIndex, material: range.material } );

		}

		return parts;

	}

	collectInstancedMesh( object ) {

		// the block holds the geometry in the mesh's own space; each instance is a reference to it
		const buffers = this.meshBuffers( object, new Matrix4(), false );
		const parts = this.meshParts( object ).map( ( part ) => ( { index: part.index, material: this.materialIndex( part.material ) } ) );

		if ( parts.length === 0 ) return;

		if ( object.instanceColor !== null ) this.warn( 'InstancedMesh instance colors are not written.' );

		const block = this.data.blocks.length;
		this.data.blocks.push( { name: unique( object.name || 'InstancedMesh', this.blockNames ), layer: this.attributes( object ).layer, buffers, parts } );

		const instanceMatrix = new Matrix4();
		const matrix = new Matrix4();

		for ( let i = 0; i < object.count; i ++ ) {

			object.getMatrixAt( i, instanceMatrix );
			matrix.multiplyMatrices( this.axes, object.matrixWorld ).multiply( instanceMatrix );

			this.data.objects.push( { type: 'instance', block, xform: matrix.toArray(), attributes: this.attributes( object ) } );

		}

	}

	// A batched mesh: each of its geometries becomes a block, and each instance a reference to it.

	collectBatchedMesh( object ) {

		const material = Array.isArray( object.material ) ? object.material[ 0 ] : object.material;
		const blocks = new Map(); // geometry id -> block index, -1 when the geometry has no triangles
		const instanceMatrix = new Matrix4();
		const matrix = new Matrix4();
		const color = new Color();
		let colored = false;

		for ( let i = 0; i < object.maxInstanceCount; i ++ ) {

			let geometryId;

			try {

				geometryId = object.getGeometryIdAt( i );

			} catch ( error ) {

				continue; // an unused or deleted instance

			}

			if ( this.options.onlyVisible && object.getVisibleAt( i ) === false ) continue;

			let block = blocks.get( geometryId );

			if ( block === undefined ) {

				block = this.batchedBlock( object, geometryId, material );
				blocks.set( geometryId, block );

			}

			if ( block < 0 ) continue;

			if ( object.getColorAt( i, color ).getHex() !== 0xffffff ) colored = true;

			object.getMatrixAt( i, instanceMatrix );
			matrix.multiplyMatrices( this.axes, object.matrixWorld ).multiply( instanceMatrix );

			this.data.objects.push( { type: 'instance', block, xform: matrix.toArray(), attributes: this.attributes( object ) } );

		}

		if ( colored ) this.warn( 'BatchedMesh instance colors are not written.' );

	}

	batchedBlock( object, geometryId, material ) {

		const range = object.getGeometryRangeAt( geometryId );
		const index = object.geometry.index;
		const count = Math.floor( range.count / 3 ) * 3;
		if ( count === 0 ) return - 1;

		// the batch's index holds batch vertex numbers: the block's start at its first vertex
		const partIndex = new Uint32Array( count );
		for ( let i = 0; i < count; i ++ ) partIndex[ i ] = ( index !== null ? index.getX( range.start + i ) : range.start + i ) - range.vertexStart;
		this.transfer.push( partIndex.buffer );

		const buffers = this.meshBuffers( object, new Matrix4(), false, range.vertexStart, range.vertexCount );
		const name = unique( `${ object.name || 'BatchedMesh' }_${ geometryId }`, this.blockNames );

		this.data.blocks.push( { name, layer: this.attributes( object ).layer, buffers, parts: [ { index: partIndex, material: this.materialIndex( material ) } ] } );

		return this.data.blocks.length - 1;

	}

	// Points and lines

	collectPoints( object ) {

		const geometry = object.geometry;
		const position = geometry.getAttribute( 'position' );
		if ( position === undefined ) return;

		const color = geometry.getAttribute( 'color' );
		const material = Array.isArray( object.material ) ? object.material[ 0 ] : object.material;
		const useColors = color !== undefined && material.vertexColors === true;

		const start = Math.max( 0, geometry.drawRange.start );
		const end = Math.min( position.count, start + geometry.drawRange.count );
		if ( end <= start ) return;

		const matrix = _m.multiplyMatrices( this.axes, object.matrixWorld );
		const buffers = { position: new Float32Array( ( end - start ) * 3 ) };
		if ( useColors ) buffers.color = new Float32Array( ( end - start ) * 3 );

		for ( let i = start; i < end; i ++ ) {

			_v.fromBufferAttribute( position, i ).applyMatrix4( matrix ).toArray( buffers.position, ( i - start ) * 3 );

			if ( useColors ) {

				buffers.color[ ( i - start ) * 3 ] = color.getX( i );
				buffers.color[ ( i - start ) * 3 + 1 ] = color.getY( i );
				buffers.color[ ( i - start ) * 3 + 2 ] = color.getZ( i );

			}

		}

		for ( const name in buffers ) this.transfer.push( buffers[ name ].buffer );

		const attributes = this.attributes( object );
		this.setColor( attributes, material );
		this.data.objects.push( { type: 'points', buffers, attributes } );

	}

	collectLine( object ) {

		const geometry = object.geometry;
		const position = geometry.getAttribute( 'position' );
		if ( position === undefined ) return;

		const index = geometry.index;
		const total = index !== null ? index.count : position.count;
		const start = Math.max( 0, geometry.drawRange.start );
		const end = Math.min( total, start + geometry.drawRange.count );

		const matrix = _m.multiplyMatrices( this.axes, object.matrixWorld );
		const vertex = ( i ) => index !== null ? index.getX( i ) : i;

		// runs of connected vertices, each one polyline
		const runs = [];

		if ( object.isLineSegments ) {

			// a segment that starts where the last one ended continues its polyline
			const same = ( a, b ) => a === b || ( position.getX( a ) === position.getX( b ) && position.getY( a ) === position.getY( b ) && position.getZ( a ) === position.getZ( b ) );
			let run = null;

			for ( let i = start; i + 1 < end; i += 2 ) {

				const a = vertex( i ), b = vertex( i + 1 );

				if ( run !== null && same( run[ run.length - 1 ], a ) ) {

					run.push( b );

				} else {

					run = [ a, b ];
					runs.push( run );

				}

			}

		} else {

			const run = [];
			for ( let i = start; i < end; i ++ ) run.push( vertex( i ) );
			if ( object.isLineLoop && run.length > 2 ) run.push( run[ 0 ] );
			runs.push( run );

		}

		this.addCurves( object, runs, ( i, target ) => target.fromBufferAttribute( position, i ).applyMatrix4( matrix ) );

	}

	// Line2 and LineSegments2 (three/addons/lines): segments with a width. A width in pixels becomes the
	// plot weight, at 96 pixels to the inch; a width in world units is not written.

	collectWideLine( object ) {

		const geometry = object.geometry;
		const instanceStart = geometry.getAttribute( 'instanceStart' );
		const instanceEnd = geometry.getAttribute( 'instanceEnd' );
		if ( instanceStart === undefined || instanceEnd === undefined ) return;

		const count = Math.min( instanceStart.count, geometry.instanceCount );
		const matrix = _m.multiplyMatrices( this.axes, object.matrixWorld );

		// a segment that starts where the last one ended continues its polyline
		const runs = [];
		let run = null;

		for ( let i = 0; i < count; i ++ ) {

			const a = new Vector3().fromBufferAttribute( instanceStart, i );
			const b = new Vector3().fromBufferAttribute( instanceEnd, i );

			if ( run !== null && run[ run.length - 1 ].equals( a ) ) {

				run.push( b );

			} else {

				run = [ a, b ];
				runs.push( run );

			}

		}

		const material = Array.isArray( object.material ) ? object.material[ 0 ] : object.material;
		let plotWeight;

		if ( material.worldUnits ) this.warn( `${ object.type } widths in world units are not written.` );
		else plotWeight = material.linewidth * 25.4 / 96;

		this.addCurves( object, runs, ( point, target ) => target.copy( point ).applyMatrix4( matrix ), plotWeight );

	}

	// One curve per run of points; the curves of one object are grouped.

	addCurves( object, runs, getPoint, plotWeight ) {

		const material = Array.isArray( object.material ) ? object.material[ 0 ] : object.material;
		const group = runs.length > 1 ? this.data.groups ++ : - 1;

		for ( const run of runs ) {

			if ( run.length < 2 ) continue;

			const points = new Float64Array( run.length * 3 );
			for ( let i = 0; i < run.length; i ++ ) getPoint( run[ i ], _v ).toArray( points, i * 3 );
			this.transfer.push( points.buffer );

			const attributes = this.attributes( object );
			this.setColor( attributes, material );
			if ( plotWeight !== undefined ) attributes.plotWeight = plotWeight;
			if ( group >= 0 ) attributes.groups.push( group );
			this.data.objects.push( { type: 'curve', points, attributes } );

		}

	}

	// The skeleton in its current pose: a line from each bone to its parent bone.

	collectSkeleton( object ) {

		const bones = object.skeleton.bones.filter( ( bone ) => bone.parent !== null && bone.parent.isBone );
		if ( bones.length === 0 ) return;

		const group = this.data.groups ++;

		for ( const bone of bones ) {

			_a.setFromMatrixPosition( bone.matrixWorld ).applyMatrix4( this.axes );
			_b.setFromMatrixPosition( bone.parent.matrixWorld ).applyMatrix4( this.axes );

			const attributes = this.attributes( object );
			attributes.name = bone.name;
			attributes.groups.push( group );
			this.data.objects.push( { type: 'curve', points: new Float64Array( [ _b.x, _b.y, _b.z, _a.x, _a.y, _a.z ] ), attributes } );

		}

	}

	// Lights

	collectLight( object ) {

		const light = { name: object.name, intensity: object.intensity, diffuse: toColor( object.color ), enabled: object.visible };
		const location = this.worldPoint( object, _a );

		if ( object.isPointLight ) {

			light.style = 'WorldPoint';

		} else if ( object.isSpotLight || object.isDirectionalLight ) {

			light.style = object.isSpotLight ? 'WorldSpot' : 'WorldDirectional';
			light.direction = this.worldPoint( object.target, _b ).sub( location ).toArray();
			if ( object.isSpotLight ) light.spotAngle = object.angle;

		} else if ( object.isRectAreaLight ) {

			// Rhino's rectangle starts at a corner; three.js's is centered and faces its -Z axis
			const matrix = _m.multiplyMatrices( this.axes, object.matrixWorld );
			const x = new Vector3().setFromMatrixColumn( matrix, 0 ).normalize().multiplyScalar( object.width );
			const y = new Vector3().setFromMatrixColumn( matrix, 1 ).normalize().multiplyScalar( object.height );
			const z = new Vector3().setFromMatrixColumn( matrix, 2 ).normalize().negate();

			light.style = 'WorldRectangular';
			location.addScaledVector( x, - 0.5 ).addScaledVector( y, - 0.5 );
			light.width = x.toArray();
			light.length = y.toArray();
			light.direction = z.toArray();

		} else if ( object.isAmbientLight || object.isHemisphereLight ) {

			if ( object.isHemisphereLight ) this.warn( 'HemisphereLight is written as an ambient light with its sky color.' );
			light.style = 'Ambient';

		} else {

			this.warn( `${ object.type } is not supported.` );
			return;

		}

		light.location = location.toArray();

		this.data.objects.push( { type: 'light', light, attributes: this.attributes( object ) } );

	}

	// Cameras become named views.

	collectCamera( camera ) {

		const view = {
			name: unique( camera.name || camera.type, this.viewNames ),
			perspective: camera.isPerspectiveCamera === true,
			location: this.worldPoint( camera, _a ).toArray(),
			direction: camera.getWorldDirection( _b ).applyMatrix3( this.axes3 ).toArray(),
			up: new Vector3().setFromMatrixColumn( camera.matrixWorld, 1 ).normalize().applyMatrix3( this.axes3 ).toArray()
		};

		if ( camera.isPerspectiveCamera ) {

			view.aspect = camera.aspect;
			view.focus = camera.focus;
			view.lens = camera.getFocalLength();

			// Rhino's camera angle is half the smaller field of view
			const halfHeight = Math.tan( camera.fov * Math.PI / 360 ) / camera.zoom;
			view.cameraAngle = Math.atan( view.aspect >= 1 ? halfHeight : halfHeight * view.aspect );

		} else {

			// the frustum, in camera coordinates
			const zoom = camera.zoom;
			view.aspect = ( camera.right - camera.left ) / ( camera.top - camera.bottom );
			view.frustum = [ camera.left / zoom, camera.bottom / zoom, - camera.far, camera.right / zoom, camera.top / zoom, - camera.near ];

		}

		this.data.views.push( view );

	}

	// Object attributes, layers, materials

	attributes( object ) {

		const attributes = { name: object.name, castsShadows: object.castShadow, receivesShadows: object.receiveShadow, userStrings: [], groups: [] };

		// an object from Rhino3dmLoader goes back on its own layer; it is hidden there when its layer is off
		const fileLayer = this.fileLayers !== undefined && object.userData.attributes !== undefined ? this.fileLayers.get( object.userData.attributes.layerIndex ) : undefined;

		if ( fileLayer !== undefined ) {

			attributes.layer = fileLayer.index;
			attributes.visible = object.visible || fileLayer.visible === false;

		} else {

			attributes.layer = this.layerIndex( object === this.root ? object : object.parent );
			attributes.visible = object.visible;

		}

		for ( const key in object.userData ) {

			// written by Rhino3dmLoader
			if ( key === 'attributes' || key === 'objectType' ) continue;

			const value = object.userData[ key ];
			if ( value === undefined || typeof value === 'function' ) continue;

			try {

				attributes.userStrings.push( [ key, typeof value === 'string' ? value : JSON.stringify( value ) ] );

			} catch ( error ) {

				this.warn( `userData.${ key } could not be written: ${ error.message }` );

			}

		}

		// what Rhino3dmLoader read from the file: the object's user strings, its geometry's, and its groups
		const fileAttributes = object.userData.objectType !== undefined ? object.userData.attributes : undefined;

		if ( fileAttributes !== undefined && fileAttributes !== null ) {

			attributes.userStrings.push( ...userStringPairs( fileAttributes.userStrings ) );

			if ( fileAttributes.geometry !== undefined && fileAttributes.geometry !== null ) {

				attributes.geometryUserStrings = userStringPairs( fileAttributes.geometry.userStrings );

			}

			for ( const id of listOf( fileAttributes.groupIds ) ) attributes.groups.push( this.fileGroup( id ) );

		}

		return attributes;

	}

	// A group of the file read by Rhino3dmLoader: its objects stay together, in a new group (names are not written).

	fileGroup( id ) {

		let group = this.fileGroups.get( id );

		if ( group === undefined ) {

			group = this.data.groups ++;
			this.fileGroups.set( id, group );

		}

		return group;

	}

	// The layers of a file read by Rhino3dmLoader (its root's userData.layers), with their ids, parents first.

	collectFileLayers( layers ) {

		this.fileLayers = new Map(); // loader layer index -> { index, visible }

		const depth = ( layer ) => layer.fullPath !== undefined ? layer.fullPath.split( '::' ).length : 1;
		const sorted = layers.map( ( layer, index ) => ( { layer, index } ) ).filter( ( entry ) => entry.layer ).sort( ( a, b ) => depth( a.layer ) - depth( b.layer ) );

		for ( const { layer, index } of sorted ) {

			this.fileLayers.set( index, { index: this.data.layers.length, visible: layer.visible !== false } );

			this.data.layers.push( {
				name: layer.name,
				id: layer.id,
				parentId: layer.parentLayerId,
				color: layer.color,
				visible: layer.visible !== false,
				locked: layer.isLocked === true
			} );

		}

	}

	// The layer for an object's children: the hierarchy becomes the layer tree, made as objects need it.

	layerIndex( object ) {

		let index = this.layerIndices.get( object );
		if ( index !== undefined ) return index;

		const isRoot = object === this.root || object.parent === null;
		const parent = isRoot ? - 1 : this.layerIndex( object.parent );

		let names = this.layerNames.get( parent );

		if ( names === undefined ) {

			names = new Set();
			this.layerNames.set( parent, names );

		}

		index = this.data.layers.length;
		this.data.layers.push( { name: unique( object.name || object.type, names ), parent, color: { r: 0, g: 0, b: 0, a: 255 }, visible: true, locked: false } );
		this.layerIndices.set( object, index );

		return index;

	}

	setMaterial( attributes, material ) {

		attributes.material = this.materialIndex( material );
		this.setColor( attributes, material );

	}

	setColor( attributes, material ) {

		if ( material.color !== undefined ) attributes.color = toColor( material.color );

	}

	materialIndex( material ) {

		let index = this.materialIndices.get( material.uuid );
		if ( index !== undefined ) return index;

		const m = { name: material.name, textures: [] };

		if ( material.color !== undefined ) m.diffuse = toColor( material.color );
		if ( material.specular !== undefined ) m.specular = toColor( material.specular );
		if ( material.shininess !== undefined ) m.shine = Math.min( material.shininess, 255 );
		if ( material.emissive !== undefined ) m.emission = _a.set( material.emissive.r, material.emissive.g, material.emissive.b ).multiplyScalar( material.emissiveIntensity ).toArray();
		if ( material.transparent ) m.transparency = 1 - material.opacity;

		if ( material.isMeshStandardMaterial ) {

			m.pbr = {
				baseColor: [ material.color.r, material.color.g, material.color.b ],
				metallic: material.metalness,
				roughness: material.roughness,
				opacity: material.transparent ? material.opacity : 1
			};

			if ( material.isMeshPhysicalMaterial ) {

				Object.assign( m.pbr, {
					clearcoat: material.clearcoat,
					clearcoatRoughness: material.clearcoatRoughness,
					sheen: material.sheen,
					specular: material.specularIntensity,
					opacityIOR: material.ior,
					anisotropic: material.anisotropy
				} );

			}

		}

		// textures: each image is embedded once, and the material's texture slots name it
		for ( const [ property, type ] of material.isMeshStandardMaterial ? PBR_TEXTURE_SLOTS : LEGACY_TEXTURE_SLOTS ) {

			const texture = material[ property ];
			if ( ! texture || ! texture.isTexture ) continue;

			// Rhino has one bump slot, which also takes normal maps
			if ( property === 'normalMap' && material.bumpMap ) continue;

			const image = this.images.get( texture.source.uuid );
			if ( image === undefined || image.bytes === null ) continue;

			m.textures.push( {
				type,
				fileName: image.fileName,
				clampU: texture.wrapS === ClampToEdgeWrapping,
				clampV: texture.wrapT === ClampToEdgeWrapping,
				repeat: [ texture.repeat.x, texture.repeat.y ],
				offset: [ texture.offset.x, texture.offset.y ],
				rotation: texture.rotation
			} );

		}

		index = this.data.materials.length;
		this.data.materials.push( m );
		this.materialIndices.set( material.uuid, index );

		return index;

	}

	// PNG bytes for each texture image the objects' materials use, by Source uuid.

	async encodeImages( objects ) {

		const images = new Map();
		const names = new Set();

		for ( const object of objects ) {

			const materials = Array.isArray( object.material ) ? object.material : ( object.material ? [ object.material ] : [] );

			for ( const material of materials ) {

				const slots = material.isMeshStandardMaterial ? PBR_TEXTURE_SLOTS : LEGACY_TEXTURE_SLOTS;

				for ( const [ property ] of slots ) {

					const texture = material[ property ];
					if ( ! texture || ! texture.isTexture || images.has( texture.source.uuid ) ) continue;

					// Rhino finds a texture by its file name, in its own texture folders too, before the embedded copy:
					// a plain name such as "checker.png" resolves to Rhino's stock texture, so the name gets an id
					const name = ( texture.name || 'texture' ).replace( /[\\/:*?"<>|]/g, '_' );
					const fileName = unique( `${ name }_${ texture.source.uuid.slice( 0, 8 ) }`, names ) + '.png';
					const image = { fileName, bytes: null };
					images.set( texture.source.uuid, image );

					try {

						image.bytes = await encodePNG( texture );

					} catch ( error ) {

						this.warn( `Texture "${ texture.name }" could not be written: ${ error.message }` );

					}

				}

			}

		}

		return images;

	}

	worldPoint( object, target ) {

		object.updateWorldMatrix( true, false );

		return target.setFromMatrixPosition( object.matrixWorld ).applyMatrix4( this.axes );

	}

	warn( message ) {

		if ( this.warnings.has( message ) ) return;

		this.warnings.add( message );
		console.warn( 'THREE.Rhino3dmExporter: ' + message );

	}

}

// Writes the collected data to a 3DM file with rhino3dm.js and returns its bytes. It runs in the worker (its source
// is copied there, so it uses nothing from this module) or, after setLibrary(), on the calling thread.
// rhino3dm.js objects are C++ objects: each one made here is deleted once it is in the document.

function write3dm( rhino, data ) {

	const doc = new rhino.File3dm();

	const point = ( a, i = 0 ) => ( { X: a[ i ], Y: a[ i + 1 ], Z: a[ i + 2 ] } );

	try {

		doc.applicationName = 'three.js';
		doc.applicationUrl = 'https://threejs.org';

		const objects = doc.objects;
		const layers = doc.layers;
		const materials = doc.materials;
		const groups = doc.allGroups;

		for ( const image of data.images ) {

			const file = rhino.File3dmEmbeddedFile.fromByteArray( image.bytes, image.fileName );
			doc.embeddedFiles.add( file );
			file.delete();

		}

		// layers, in order: a layer's index is its position in data.layers
		for ( const layer of data.layers ) {

			const l = new rhino.Layer();

			l.name = layer.name;
			if ( layer.id !== undefined ) l.id = layer.id;

			if ( layer.parentId !== undefined ) {

				l.parentLayerId = layer.parentId;

			} else if ( layer.parent >= 0 ) {

				const parent = layers.findIndex( layer.parent );
				l.parentLayerId = parent.id;
				parent.delete();

			}

			if ( layer.color !== undefined ) l.color = layer.color;
			l.isVisible = layer.visible;
			l.isLocked = layer.locked;

			layers.add( l );
			l.delete();

		}

		// materials, in order: a material's index is its position in data.materials
		for ( const material of data.materials ) {

			const m = new rhino.Material();

			m.name = material.name;
			if ( material.diffuse !== undefined ) m.diffuseColor = material.diffuse;
			if ( material.specular !== undefined ) m.specularColor = material.specular;
			if ( material.shine !== undefined ) m.shine = material.shine;
			if ( material.emission !== undefined ) m.emissionColor = color( material.emission );
			if ( material.transparency !== undefined ) m.transparency = material.transparency;

			if ( material.pbr !== undefined ) {

				m.toPhysicallyBased();

				const pbr = m.physicallyBased;
				const values = material.pbr;

				pbr.baseColor = { R: values.baseColor[ 0 ], G: values.baseColor[ 1 ], B: values.baseColor[ 2 ], A: 1 };
				if ( material.emission !== undefined ) pbr.emission = { R: material.emission[ 0 ], G: material.emission[ 1 ], B: material.emission[ 2 ], A: 1 };

				for ( const name of [ 'metallic', 'roughness', 'opacity', 'clearcoat', 'clearcoatRoughness', 'sheen', 'specular', 'opacityIOR', 'anisotropic' ] ) {

					if ( values[ name ] !== undefined ) pbr[ name ] = values[ name ];

				}

				pbr.delete();

			}

			for ( const texture of material.textures ) {

				const t = new rhino.Texture();

				t.fileName = texture.fileName;
				t.wrapU = texture.clampU ? rhino.TextureUvwWrapping.Clamp : rhino.TextureUvwWrapping.Repeat;
				t.wrapV = texture.clampV ? rhino.TextureUvwWrapping.Clamp : rhino.TextureUvwWrapping.Repeat;
				t.repeat = { X: texture.repeat[ 0 ], Y: texture.repeat[ 1 ] };
				t.offset = { X: texture.offset[ 0 ], Y: texture.offset[ 1 ] };
				t.rotation = texture.rotation;

				m.setTexture( t, rhino.TextureType[ texture.type ] );
				t.delete();

			}

			materials.addMaterial( m );
			m.delete();

		}

		for ( let i = 0; i < data.groups; i ++ ) groups.addGroup();

		for ( const [ key, value ] of data.strings ) doc.strings.setString( key, value );

		// blocks: each holds its meshes, one per material
		const blocks = data.blocks.map( ( block ) => {

			const meshes = [], blockAttributes = [];

			for ( const part of block.parts ) {

				const mesh = createMesh( block.buffers, part.index );
				if ( mesh === null ) continue;

				// the block's geometry is on the layer of its references
				const a = new rhino.ObjectAttributes();
				a.layerIndex = block.layer;
				a.materialSource = rhino.ObjectMaterialSource.MaterialFromObject;
				a.materialIndex = part.material;

				meshes.push( mesh );
				blockAttributes.push( a );

			}

			if ( meshes.length === 0 ) return - 1;

			const index = doc.instanceDefinitions.add( block.name, '', { X: 0, Y: 0, Z: 0 }, meshes, blockAttributes );

			for ( const mesh of meshes ) mesh.delete();
			for ( const a of blockAttributes ) a.delete();

			return index;

		} );

		for ( const object of data.objects ) {

			switch ( object.type ) {

				case 'mesh':

					for ( const part of object.parts ) {

						const mesh = createMesh( object.buffers, part.index );
						if ( mesh !== null ) add( mesh, part.attributes );

					}

					break;

				case 'points':

					add( rhino.PointCloud.createFromThreejsBuffers( object.buffers, false ), object.attributes );
					break;

				case 'curve': {

					const p = object.points;
					const count = p.length / 3;
					const points = [];
					for ( let i = 0; i < count; i ++ ) points.push( point( p, i * 3 ) );

					add( count === 2 ? new rhino.LineCurve( points[ 0 ], points[ 1 ] ) : new rhino.PolylineCurve( points ), object.attributes );
					break;

				}

				case 'instance': {

					if ( blocks[ object.block ] < 0 ) break;

					// three.js matrices are column-major
					const e = object.xform;
					const xform = {};
					for ( let row = 0; row < 4; row ++ ) for ( let column = 0; column < 4; column ++ ) xform[ `M${ row }${ column }` ] = e[ column * 4 + row ];

					const a = attributes( object.attributes );
					objects.addInstanceObject( blocks[ object.block ], xform, a );
					a.delete();
					break;

				}

				case 'light': {

					const values = object.light;
					const light = new rhino.Light();

					light.lightStyle = rhino.LightStyle[ values.style ];
					light.location = point( values.location );
					if ( values.direction !== undefined ) light.direction = point( values.direction );
					if ( values.width !== undefined ) light.width = point( values.width );
					if ( values.length !== undefined ) light.length = point( values.length );
					if ( values.spotAngle !== undefined ) light.spotAngleRadians = values.spotAngle;
					light.name = values.name;
					light.intensity = values.intensity;
					light.diffuse = values.diffuse;
					light.isEnabled = values.enabled;

					add( light, object.attributes );
					break;

				}

			}

		}

		for ( const values of data.views ) {

			const view = new rhino.ViewInfo();
			const viewport = view.viewport;

			view.name = values.name;

			if ( values.perspective ) viewport.changeToPerspectiveProjection( values.focus, true, values.lens );
			else viewport.changeToParallelProjection( true );

			viewport.setCameraLocation( point( values.location ) );
			viewport.setCameraDirection( point( values.direction ) );
			viewport.setCameraUp( point( values.up ) );

			// a valid screen port, which dollyExtents() needs; its aspect is the camera's
			viewport.screenPort = [ 0, 0, Math.round( 1000 * values.aspect ), 1000 ];
			viewport.frustumAspect = values.aspect;

			if ( values.perspective ) {

				viewport.cameraAngle = values.cameraAngle;

			} else {

				const f = values.frustum;
				viewport.dollyExtents( { Min: point( f, 0 ), Max: point( f, 3 ) }, 0 );

			}

			doc.namedViews.add( view );

			// the viewport belongs to the view: deleting both frees it twice
			view.delete();

		}

		if ( data.units || data.background !== undefined ) {

			const settings = doc.settings;

			if ( data.units ) {

				const unitSystem = rhino.UnitSystem[ data.units ];

				if ( unitSystem === undefined ) {

					console.warn( `THREE.Rhino3dmExporter: unknown units "${ data.units }".` );

				} else {

					try {

						settings.modelUnitSystem = unitSystem;

					} catch ( error ) {

						// read-only before rhino3dm 9.2.0
						console.warn( 'THREE.Rhino3dmExporter: this rhino3dm.js cannot set units.' );

					}

				}

			}

			if ( data.background !== undefined ) {

				const renderSettings = settings.renderSettings;
				renderSettings.backgroundStyle = rhino.BackgroundStyle.SolidColor;
				renderSettings.backgroundColorTop = data.background;
				renderSettings.backgroundColorBottom = data.background;
				renderSettings.delete();

			}

			settings.delete();

		}

		const writeOptions = new rhino.File3dmWriteOptions();
		writeOptions.version = data.version;
		const bytes = doc.toByteArray( writeOptions ).slice();
		writeOptions.delete();

		return bytes;

		// helpers

		function attributes( values ) {

			const a = new rhino.ObjectAttributes();

			a.name = values.name;
			a.layerIndex = values.layer;
			a.visible = values.visible;
			a.castsShadows = values.castsShadows;
			a.receivesShadows = values.receivesShadows;

			if ( values.material !== undefined ) {

				a.materialSource = rhino.ObjectMaterialSource.MaterialFromObject;
				a.materialIndex = values.material;

			}

			if ( values.color !== undefined ) {

				a.colorSource = rhino.ObjectColorSource.ColorFromObject;
				a.objectColor = values.color;

			}

			if ( values.plotWeight !== undefined ) {

				a.plotWeightSource = rhino.ObjectPlotWeightSource.PlotWeightFromObject;
				a.plotWeight = values.plotWeight;

			}

			for ( const [ key, value ] of values.userStrings ) a.setUserString( key, value );
			for ( const group of values.groups ) a.addToGroup( group );

			return a;

		}

		function add( geometry, values ) {

			if ( values.geometryUserStrings !== undefined ) {

				for ( const [ key, value ] of values.geometryUserStrings ) geometry.setUserString( key, value );

			}

			const a = attributes( values );
			objects.add( geometry, a );
			geometry.delete();
			a.delete();

		}

		function createMesh( buffers, index ) {

			const mesh = rhino.Mesh.createFromThreejsBuffers( Object.assign( {}, buffers, { index } ), false );

			// a part uses only some of the vertices
			mesh.compact();

			if ( mesh.faces.count === 0 ) {

				mesh.delete();
				return null;

			}

			if ( mesh.normals.count === 0 ) mesh.normals.computeNormals();

			return mesh;

		}

		function color( rgb ) {

			const c = ( value ) => Math.round( Math.min( Math.max( value, 0 ), 1 ) * 255 );

			return { r: c( rgb[ 0 ] ), g: c( rgb[ 1 ] ), b: c( rgb[ 2 ] ), a: 255 };

		}

	} finally {

		// the tables' own delete( item ) hides the wrapper's delete(), so only the document is deleted
		doc.delete();

	}

}

// The worker: rhino3dm.js and write3dm() are prepended to this function's body.

function Rhino3dmExporterWorker() {

	let libraryPending;

	onmessage = function ( event ) {

		const message = event.data;

		switch ( message.type ) {

			case 'init':

				libraryPending = rhino3dm( { wasmBinary: message.wasmBinary } ); // eslint-disable-line no-undef
				break;

			case 'write':

				libraryPending.then( ( rhino ) => {

					let bytes;

					try {

						bytes = write3dm( rhino, message.data );

					} catch ( error ) {

						self.postMessage( { type: 'error', id: message.id, error: errorText( rhino, error ) } );
						return;

					}

					self.postMessage( { type: 'done', id: message.id, bytes }, [ bytes.buffer ] );

				} ).catch( ( error ) => {

					self.postMessage( { type: 'error', id: message.id, error: errorText( null, error ) } );

				} );

				break;

		}

	};

	// rhino3dm throws WebAssembly.Exception; its text is read (and the exception freed) through the module
	function errorText( rhino, error ) {

		if ( rhino !== null && typeof WebAssembly.Exception === 'function' && error instanceof WebAssembly.Exception ) {

			const text = String( rhino.getExceptionMessage( error ) );
			rhino.decrementExceptionRefcount( error );
			return text;

		}

		return String( error && error.message || error );

	}

}

// three.js material maps -> Rhino texture types, as Rhino3dmLoader reads them back
const PBR_TEXTURE_SLOTS = [
	[ 'map', 'PBR_BaseColor' ],
	[ 'alphaMap', 'PBR_Alpha' ],
	[ 'aoMap', 'PBR_AmbientOcclusion' ],
	[ 'anisotropyMap', 'PBR_Anisotropic' ],
	[ 'bumpMap', 'Bump' ],
	[ 'normalMap', 'Bump' ],
	[ 'clearcoatMap', 'PBR_Clearcoat' ],
	[ 'clearcoatNormalMap', 'PBR_ClearcoatBump' ],
	[ 'clearcoatRoughnessMap', 'PBR_ClearcoatRoughness' ],
	[ 'displacementMap', 'PBR_Displacement' ],
	[ 'emissiveMap', 'PBR_Emission' ],
	[ 'metalnessMap', 'PBR_Metallic' ],
	[ 'roughnessMap', 'PBR_Roughness' ],
	[ 'sheenColorMap', 'PBR_Sheen' ],
	[ 'specularColorMap', 'PBR_Specular' ],
	[ 'thicknessMap', 'PBR_Subsurface' ]
];

const LEGACY_TEXTURE_SLOTS = [
	[ 'map', 'Diffuse' ],
	[ 'alphaMap', 'Transparency' ],
	[ 'bumpMap', 'Bump' ],
	[ 'normalMap', 'Bump' ]
];

// A texture's image as PNG bytes. Rhino reads an image file the way three.js does with flipY = true,
// so an image used with flipY = false (glTF, DataTexture) is flipped.

async function encodePNG( texture ) {

	if ( texture.isCompressedTexture ) throw new Error( 'compressed textures are not supported' );

	let image = texture.image;
	if ( ! image || ! image.width || ! image.height ) throw new Error( 'the texture has no image data' );

	const { width, height } = image;

	if ( image.data !== undefined ) {

		// DataTexture: RGBA bytes
		if ( ! ( image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray ) || image.data.length !== width * height * 4 ) {

			throw new Error( 'only RGBA8 DataTextures are supported' );

		}

		const source = createCanvas( width, height );
		source.getContext( '2d' ).putImageData( new ImageData( new Uint8ClampedArray( image.data ), width, height ), 0, 0 );
		image = source;

	}

	const canvas = createCanvas( width, height );
	const context = canvas.getContext( '2d' );

	if ( texture.flipY === false ) {

		context.translate( 0, height );
		context.scale( 1, - 1 );

	}

	context.drawImage( image, 0, 0, width, height );

	const blob = canvas.convertToBlob !== undefined
		? await canvas.convertToBlob( { type: 'image/png' } )
		: await new Promise( ( resolve ) => canvas.toBlob( resolve, 'image/png' ) );

	return new Uint8Array( await blob.arrayBuffer() );

}

function createCanvas( width, height ) {

	if ( typeof OffscreenCanvas !== 'undefined' ) return new OffscreenCanvas( width, height );

	const canvas = document.createElement( 'canvas' );
	canvas.width = width;
	canvas.height = height;

	return canvas;

}

// An array, or a typed array, as an array; anything else as an empty one.
function listOf( value ) {

	return Array.isArray( value ) || ArrayBuffer.isView( value ) ? Array.from( value ) : [];

}

// User strings as Rhino3dmLoader reads them, [ key, value ] pairs, as strings.
function userStringPairs( pairs ) {

	return listOf( pairs ).filter( ( pair ) => listOf( pair ).length === 2 ).map( ( pair ) => [ String( pair[ 0 ] ), String( pair[ 1 ] ) ] );

}

function unique( name, names ) {

	let result = name;
	for ( let i = 2; names.has( result ); i ++ ) result = `${ name } (${ i })`;
	names.add( result );

	return result;

}

// three.js colors are linear; the values are written as they are, as Rhino3dmLoader reads them
function toColor( color ) {

	const c = ( value ) => Math.round( Math.min( Math.max( value, 0 ), 1 ) * 255 );

	return { r: c( color.r ), g: c( color.g ), b: c( color.b ), a: 255 };

}

/**
 * Export options of `Rhino3dmExporter`.
 *
 * @typedef {Object} Rhino3dmExporter~Options
 * @property {boolean} [onlyVisible=true] - Export only visible 3D objects.
 * @property {boolean} [rotateFromYUp=false] - Rotate three.js's Y-up to Rhino's Z-up. Leave it off for
 * content that is already Z-up, such as what {@link Rhino3dmLoader} returns.
 * @property {boolean} [skeletons=true] - Export the skeleton of each skinned mesh as lines.
 * @property {string} [units=''] - The file's unit system, a name from rhino3dm's `UnitSystem` such as
 * `'Meters'`. Empty leaves rhino3dm's default. Needs rhino3dm.js 9.2.0 or later.
 * @property {number} [version=8] - The Rhino version to write, from 2 to rhino3dm's own version; 0 writes
 * rhino3dm's version. A Rhino version can't open files written for later versions.
 **/

/**
 * onDone callback of `Rhino3dmExporter`.
 *
 * @callback Rhino3dmExporter~OnDone
 * @param {Uint8Array} result - The 3DM file's bytes.
 */

/**
 * onError callback of `Rhino3dmExporter`.
 *
 * @callback Rhino3dmExporter~OnError
 * @param {Error} error - The error object.
 */

export { Rhino3dmExporter };
