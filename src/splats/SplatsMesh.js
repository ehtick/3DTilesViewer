import {
    Mesh, InstancedMesh, ShaderMaterial, Vector2, Vector3, Vector4, Box2, Box3, DataArrayTexture,
    FloatType, HalfFloatType, UnsignedIntType, RGBAIntegerFormat, FrontSide, AlwaysDepth, PlaneGeometry, Matrix3,
    NearestFilter, Data3DTexture, DataTexture, UnsignedByteType, BufferAttribute, InstancedBufferAttribute, DynamicDrawUsage,
    LinearSRGBColorSpace, InstancedBufferGeometry,
    WebGL3DRenderTarget, OrthographicCamera, Scene,
    NeverDepth, MathUtils, GLSL3, DataUtils, CustomBlending, OneMinusSrcAlphaFactor, OneFactor, Matrix4
} from "three";
import { gamma } from 'mathjs';
import {
    MinPriorityQueue
} from 'data-structure-typed';
import { SplatsCollider } from "./SplatsColider";
import WorkerConstructor from './PointsManager.worker.js?worker';

const tmpVector = new Vector3();
const tmpVector2 = new Vector3();
const zUpToYUpMatrix3x3 = new Matrix3();
zUpToYUpMatrix3x3.set(
    1, 0, 0,
    0, 0, 1,
    0, -1, 0);
    const inverseZUpToYUpMatrix4x4 = new Matrix4().set(
        1, 0,  0, 0, 
        0, 0, -1, 0, 
        0, 1,  0, 0, 
        0, 0,  0, 1
    );

function packHalf2x16(x, y) {
    return (DataUtils.toHalfFloat(x) | (DataUtils.toHalfFloat(y) << 16)) >>> 0;
}
class SplatsMesh extends Mesh {
    constructor(renderer, isStatic, fragShader) {

        const textureSize = 1024;

        const numTextures = 1;
        const batchSize = Math.min(Math.ceil(4096 / textureSize) * textureSize, Math.pow(textureSize, 2));
        let maxSplats = numTextures * Math.pow(textureSize, 2);
        maxSplats = Math.floor(maxSplats / batchSize) * batchSize;


        const positionColorRenderTarget = new WebGL3DRenderTarget(textureSize, textureSize, numTextures, {
            magFilter: NearestFilter,
            minFilter: NearestFilter,
            type: UnsignedIntType,
            format: RGBAIntegerFormat,
            anisotropy: 0,
            depthBuffer: false,
            resolveDepthBuffer: false,
        })
        positionColorRenderTarget.texture.type = UnsignedIntType;
        positionColorRenderTarget.texture.format = RGBAIntegerFormat;
        positionColorRenderTarget.texture.internalFormat = 'RGBA32UI';
        renderer.initRenderTarget(positionColorRenderTarget);


        const covarianceRenderTarget = new WebGL3DRenderTarget(textureSize, textureSize, numTextures, {
            magFilter: NearestFilter,
            minFilter: NearestFilter,
            anisotropy: 0,
            type: UnsignedIntType,
            format: RGBAIntegerFormat,
            depthBuffer: false,
            resolveDepthBuffer: false,
        })
        covarianceRenderTarget.texture.type = UnsignedIntType;
        covarianceRenderTarget.texture.format = RGBAIntegerFormat;
        covarianceRenderTarget.texture.internalFormat = 'RGBA32UI';
        renderer.initRenderTarget(covarianceRenderTarget);



        const material = new ShaderMaterial(
            {
                glslVersion: GLSL3,
                uniforms: {
                    textureSize: { value: textureSize },
                    numSlices: { value: numTextures },
                    covarianceTexture: { value: covarianceRenderTarget.texture },
                    positionColorTexture: { value: positionColorRenderTarget.texture },
                    zUpToYUpMatrix3x3: { value: zUpToYUpMatrix3x3 },
                    sizeMultiplier: { value: 1 },
                    cropRadius: { value: Number.MAX_VALUE },
                    //cameraNear: { value: 0.01 },
                    //cameraFar: { value: 10 },
                    //computeLinearDepth: { value: true },
                    viewportPixelSize: { value: new Vector2() },
                    k: { value: 2 },
                    beta_k: { value: 2 },
                    minSplatPixelSize: { value: 0 },
                    minOpacity: { value: 0.01 },
                    culling: {value: false},
                    antialiasingFactor: {value: 2.0}
                },
                vertexShader: splatsVertexShader(),
                fragmentShader: fragShader ? fragShader : splatsFragmentShader(),
                transparent: true,
                side: FrontSide,
                depthTest: false,
                depthWrite: false,
                /* premultipliedAlpha: true,
                blending: CustomBlending,
                blendSrc: OneFactor,
                blendSrcAlpha: OneFactor,
                blendDst: OneMinusSrcAlphaFactor,
                blendDstAlpha: OneMinusSrcAlphaFactor,
                renderOrder: 1 */
                //depthFunc: AlwaysDepth
            }
        );
        const geometry = new InstancedBufferGeometry();
        const vertices = new Float32Array([-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]);
        const indices = [0, 2, 1, 2, 3, 1];

        geometry.setIndex(indices);
        geometry.setAttribute('position', new BufferAttribute(vertices, 3));
        const order = new Uint32Array(maxSplats);

        const orderAttribute = new InstancedBufferAttribute(order, 1, false);
        orderAttribute.needsUpdate = true
        orderAttribute.setUsage(DynamicDrawUsage);
        geometry.setAttribute('order', orderAttribute);
        geometry.instanceCount = 0;


        super(geometry, material);
        this.matrixAutoUpdate = false;
        this.numBatches = 0;
        this.numVisibleBatches = 0;
        this.orderAttribute = orderAttribute;
        this.textureSize = textureSize;
        this.numTextures = numTextures;
        this.batchSize = batchSize;
        this.maxSplats = maxSplats;
        this.numSplatsRendered = 0;

        this.positionColorRenderTarget = positionColorRenderTarget;
        this.covarianceRenderTarget = covarianceRenderTarget;

        this.renderer = renderer;

        this.sortID = 0;

        this.freeAddresses = new MinPriorityQueue();
        for (let i = 0; i < this.maxSplats; i += batchSize) {
            this.freeAddresses.add(i);
        }

        this.worker = new WorkerConstructor({ type: 'module' });

        this.sortListeners = [];
        this.worker.onmessage = message => {
            //console.log(message.data.sortPerf)
            const newOrder = new Uint32Array(message.data.order);
            this.numSplatsRendered = newOrder.length;
            //console.log(newOrder.length)
            if (newOrder.length > this.orderAttribute.count) {
                const geometry = new InstancedBufferGeometry();
                const vertices = new Float32Array([-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]);
                const indices = [0, 2, 1, 2, 3, 1];

                geometry.setIndex(indices);
                geometry.setAttribute('position', new BufferAttribute(vertices, 3));
                const order = new Uint32Array(this.maxSplats);

                const orderAttribute = new InstancedBufferAttribute(order, 1, false);
                orderAttribute.needsUpdate = true
                orderAttribute.setUsage(DynamicDrawUsage);
                geometry.setAttribute('order', orderAttribute);
                geometry.instanceCount = 0;

                this.geometry.dispose();
                this.geometry = geometry;
                this.orderAttribute = orderAttribute;
            }
            this.orderAttribute.clearUpdateRanges();
            this.orderAttribute.set(newOrder);
            this.orderAttribute.addUpdateRange(0, newOrder.length);
            this.orderAttribute.needsUpdate = true;
            this.geometry.instanceCount = message.data.count;
            //console.log(this.geometry.instanceCount)
            this.geometry.needsUpdate = true;
            for (let i = this.sortListeners.length - 1; i >= 0; i--) {
                const done = this.sortListeners[i](message.data.id);
                if (done) {
                    this.sortListeners.splice(i, 1);
                }
            }
        }
        this.cameraPosition = new Vector3(0, 0, 0);
        this.viewProjModel;
        this.rotateOnAxis(new Vector3(1, 0, 0), Math.PI * 0.5);
        this.frustumCulled = false;


        /// Copy setup ///
        this.copyMaterial2D = new ShaderMaterial(
            {
                glslVersion: GLSL3,
                uniforms: {
                    sourceTexture: {},
                },
                vertexShader: vertexCopyShader(),
                fragmentShader: fragmentCopyShader2D(),
                transparent: false,
                side: FrontSide,
                depthTest: false,
                depthWrite: false
            }
        );
        this.copyMaterial3D = new ShaderMaterial(
            {
                glslVersion: GLSL3,
                uniforms: {
                    sourceTexture: {},
                    w: { value: 0.0 }
                },
                vertexShader: vertexCopyShader(),
                fragmentShader: fragmentCopyShader3D(),
                transparent: false,
                side: FrontSide,
                depthTest: false,
                depthWrite: false
            }
        );
        this.copyCamera = new OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 10);
        this.copyCamera.position.z = 1;
        this.copyScene = new Scene();
        const copyGeometry = new PlaneGeometry(1, 1);
        this.copyQuad = new Mesh(copyGeometry, this.copyMaterial2D);
        this.copyScene.add(this.copyQuad);
        this.copyScene.matrixAutoUpdate = false;
        this.copyQuad.matrixAutoUpdate = false;
        this.splatsCPUCuling = false;

    }
    /**
     * Sets the splats visualization quality where 1 is the maximum quality and 0 is the fastest
     * @param {number} quality value between 0 and 1 (1 highest quality) 
     */
    setQuality(quality) {
        quality = Math.max(0, Math.min(1, (1 - quality)));
        const k = 2 + quality * 2;
        this.material.uniforms.k.value = k;
        this.material.uniforms.beta_k.value = Math.pow((4.0 * gamma(2.0 / k)) / k, k / 2);
        this.material.uniforms.minSplatPixelSize.value = quality * 5;
        this.material.uniforms.minOpacity.value = 0.01;// + quality * 0.09;
    }
    setSplatsCPUCulling(splatsCPUCuling){
        this.splatsCPUCuling = splatsCPUCuling;
        this.material.uniforms.culling.value = splatsCPUCuling;
    }
    updateShaderParams(camera) {
        const proj = camera.projectionMatrix.elements;

        this.renderer.getSize(this.material.uniforms.viewportPixelSize.value);
        const pixelRatio = this.renderer.getPixelRatio();
        this.material.uniforms.viewportPixelSize.value.multiplyScalar(pixelRatio)
        if(pixelRatio<1){
            this.material.uniforms.antialiasingFactor.value = 2;//pixelRatio;
        }else{
            this.material.uniforms.antialiasingFactor.value = 2;
        }
        
    }
    dispose() {
        this.material.dispose();
        this.copyMaterial2D.dispose();
        this.copyMaterial3D.dispose();
        this.covarianceRenderTarget.dispose();
        this.positionColorRenderTarget.dispose();
        this.worker.terminate();
        this.worker = null;
        this.orderAttribute.array = undefined;
        this.geometry.dispose();
    }

    copyTex2D(src, dst, scissorBox, layer) {
        this.copyMaterial2D.uniforms.sourceTexture.value = src;
        const prevAutoClear = this.renderer.autoClear;
        const prevRenderTarget = this.renderer.getRenderTarget();
        this.renderer.autoClear = false;
        const scissorWidth = scissorBox[2] - scissorBox[0];
        const scissorHeight = scissorBox[3] - scissorBox[1];
        dst.viewport.set(scissorBox[0], scissorBox[1], scissorWidth, scissorHeight);

        this.renderer.setRenderTarget(dst, layer);
        this.renderer.render(this.copyScene, this.copyCamera);

        this.renderer.setRenderTarget(prevRenderTarget);

        this.renderer.autoClear = prevAutoClear;

    }

    copyTex3D(src, dst, numLayers) {
        this.copyMaterial3D.uniforms.sourceTexture.value = src;

        const prevAutoClear = this.renderer.autoClear;
        const prevRenderTarget = this.renderer.getRenderTarget();
        this.renderer.autoClear = false;

        this.copyQuad.material = this.copyMaterial3D;

        for (let layer = 0; layer < numLayers; layer++) {
            this.renderer.setRenderTarget(dst, layer);
            this.copyMaterial3D.uniforms.w.value = (layer + 0.5) / (numLayers);
            this.renderer.render(this.copyScene, this.copyCamera);
        }

        this.copyQuad.material = this.copyMaterial2D;

        this.renderer.setRenderTarget(prevRenderTarget);
        this.renderer.autoClear = prevAutoClear;

    }

    /**
     * Specify a size multiplier for splats
     * @param {number} sizeMultiplier 
     */
    setSplatsSizeMultiplier(sizeMultiplier) {
        this.material.uniforms.sizeMultiplier.value = sizeMultiplier;
    }
    /**
     * specify a crop radius for splats
     * @param {number} cropRadius 
     */
    setSplatsCropRadius(cropRadius) {
        this.material.uniforms.cropRadius.value = cropRadius;
    }

    sort(cameraPosition, viewProjModel) {
        if (!this.worker) return;
        if (!cameraPosition) {
            this.worker.postMessage({
                method: "sort",
                xyz: [this.cameraPosition.x, this.cameraPosition.z, -this.cameraPosition.y],
                vpm: this.viewProjModel && this.splatsCPUCuling?this.viewProjModel.toArray():undefined,
                id: this.sortID++
            })
        }
        else if (!this.cameraPosition || !cameraPosition.equals(this.cameraPosition)) {
            this.cameraPosition.copy(cameraPosition);
            if(!!viewProjModel){
                if (!this.viewProjModel) this.viewProjModel = new Matrix4();
                this.viewProjModel.copy(viewProjModel);
                this.viewProjModel.multiply(inverseZUpToYUpMatrix4x4);
            }else{
                this.viewProjModel = undefined;
            }
            
            
            this.worker.postMessage({
                method: "sort",
                xyz: [this.cameraPosition.x, this.cameraPosition.z, -this.cameraPosition.y],
                vpm: this.viewProjModel && this.splatsCPUCuling?this.viewProjModel.toArray():undefined,
                id: this.sortID++
            })
        }
    }
    raycast(raycaster, intersects) {
        // overrides the method because the SplatsMesh itself is not meant to be raycast onto, the tiles should be individualy raycast
    }

    addSplatsTile(positions, colors, cov1, cov2) {
        if (!this.worker) return;
        const self = this;

        const positionArray = positions.data ? positions.data.array : positions.array;
        const stride = positions.data && positions.data.isInterleavedBuffer ? positions.data.stride : 3;
        const offset = positions.data && positions.data.isInterleavedBuffer ? positions.offset : 0;
        const numBatches = Math.ceil(positionArray.length / (this.batchSize * stride));
        const textureAddresses = [];
        const pointManagerAddresses = [];


        /// raycasting ///
        // const start = performance.now();
        let raycast = () => { }
        const positionsOnly = new Float32Array((positionArray.length / stride) * 3);
        const posU32 = new Uint32Array(
            positionsOnly.buffer,
            positionsOnly.byteOffset,
            positionsOnly.length                                              // same element count
        );

        for (let i = 0; i < positionArray.length / 3; i++) {
            positionsOnly[i * 3] = positionArray[i * stride + offset];
            positionsOnly[i * 3 + 1] = positionArray[i * stride + offset + 1];
            positionsOnly[i * 3 + 2] = positionArray[i * stride + offset + 2];
        }

        // console.log(performance.now()-start)
        raycast = (ray, intersects, threshold) => {
            const threshSquared = threshold * threshold;
            for (let i = 0; i < positionsOnly.length; i += 3) {
                tmpVector.set(positionsOnly[i], -positionsOnly[i + 2], positionsOnly[i + 1])
                const dot = tmpVector2.copy(tmpVector).sub(ray.origin).dot(ray.direction);
                if (dot > 0) {
                    const d = ray.distanceSqToPoint(tmpVector);
                    if (d < threshSquared) {
                        intersects.push({ distance: dot, point: tmpVector.clone(), type: "splat" });
                    }
                }
            }
        }

        if (numBatches > this.freeAddresses.size) {
            this.growTextures();
        }

        for (let i = 0; i < numBatches; i++) {
            const address = this.freeAddresses.poll();
            if (isNaN(address)) {
                console.log("insuficient texture size to store splats info")
            }
            if (address == 0) {
            }
            textureAddresses.push(address);
            pointManagerAddresses.push(address * 3);
            const startIndex = i * this.batchSize;
            this.addSplatsBatch(startIndex, address, posU32, colors, cov1, cov2);
        }


        self.worker.postMessage({
            method: "addBatches",
            insertionIndexes: pointManagerAddresses,
            positions: positionArray.buffer,
            offset: offset,
            stride: stride,
            batchSize: self.batchSize,
        }, [positionArray.buffer]);

        let visible = false;
        const hide = () => {

            if (visible == true && self.worker) {
                self.numVisibleBatches--;
                visible = false;
                self.worker.postMessage({
                    method: "hideBatches",
                    insertionIndexes: pointManagerAddresses,
                    xyz: [self.cameraPosition.x, self.cameraPosition.z, -self.cameraPosition.y],
                    vpm: this.viewProjModel && this.splatsCPUCuling?this.viewProjModel.toArray():undefined,
                    id: self.sortID++
                });
            }

        }


        const show = (callback) => {
            if (visible == false && self.worker) {
                self.numVisibleBatches--;
                visible = true;
                const sortID = self.sortID;
                const listener = (id => {
                    if (id >= sortID) {
                        callback();
                        return true;
                    }
                    return false;
                });
                self.sortListeners.push(listener)

                self.worker.postMessage({
                    method: "showBatches",
                    insertionIndexes: pointManagerAddresses,
                    xyz: [self.cameraPosition.x, self.cameraPosition.z, -self.cameraPosition.y],
                    vpm: this.viewProjModel && this.splatsCPUCuling?this.viewProjModel.toArray():undefined,
                    id: self.sortID++
                });
            }


        }
        const remove = () => {
            if (!self.worker) return;
            raycast = undefined;
            self.worker.postMessage({
                method: "removeBatches",
                insertionIndexes: pointManagerAddresses,
                xyz: [self.cameraPosition.x, self.cameraPosition.z, -self.cameraPosition.y],
                vpm: this.viewProjModel && this.splatsCPUCuling?this.viewProjModel.toArray():undefined,
                id: self.sortID++
            });
            textureAddresses.forEach(address => self.freeAddresses.add(address));
        }





        return {
            hide: hide,
            show: show,
            remove: remove,
            sort: this.sort,
            raycast: raycast,
            isSplatsBatch: true
        }

    }


    addSplatsBatch(positionsStartIndex, address, positions, colors, cov1, cov2) {


        const positionColorArray = new Uint32Array(this.batchSize * 4);
        const covarianceArray = new Uint32Array(this.batchSize * 4);


        for (let i = address; i < address + this.batchSize; i++) {
            const base = i - address;
            const arrayIndexBase4 = base * 4;

            const positionIndex = positionsStartIndex + base;
            const pIndex3 = 3 * (positionsStartIndex + base)

            if (positionIndex >= positions.count) break;

            function f32ToU32(f) {
                return (new Uint32Array(new Float32Array([f]).buffer))[0];
            }
            positionColorArray[arrayIndexBase4] = positions[pIndex3];
            positionColorArray[arrayIndexBase4 + 1] = positions[pIndex3 + 1];
            positionColorArray[arrayIndexBase4 + 2] = positions[pIndex3 + 2];


            const r = Math.floor(colors.getX(positionIndex) * 255 + 0.5) | 0;
            const g = Math.floor(colors.getY(positionIndex) * 255 + 0.5) | 0;
            const b = Math.floor(colors.getZ(positionIndex) * 255 + 0.5) | 0;
            const a = Math.floor(colors.getW(positionIndex) * 255 + 0.5) | 0;
            positionColorArray[arrayIndexBase4 + 3] = r | (g << 8) | (b << 16) | (a << 24)


            covarianceArray[arrayIndexBase4] = packHalf2x16(cov1.getX(positionIndex), cov1.getY(positionIndex))
            covarianceArray[arrayIndexBase4 + 1] = packHalf2x16(cov1.getZ(positionIndex), cov2.getX(positionIndex))
            covarianceArray[arrayIndexBase4 + 2] = packHalf2x16(cov2.getY(positionIndex), cov2.getZ(positionIndex))


        }

        const destTextureLayer = Math.floor(address / Math.pow(this.textureSize, 2));
        const srcHeight = Math.ceil(this.batchSize / this.textureSize);
        const scissor = [0, (address / this.textureSize) - (destTextureLayer * this.textureSize), this.textureSize];
        scissor.push(scissor[1] + srcHeight);
        const batchPositionColorTexture = new DataTexture(positionColorArray, this.textureSize, srcHeight, RGBAIntegerFormat, UnsignedIntType);
        batchPositionColorTexture.internalFormat = 'RGBA32UI';
        batchPositionColorTexture.generateMipmaps = false;
        batchPositionColorTexture.magFilter = NearestFilter;
        batchPositionColorTexture.minFilter = NearestFilter;
        batchPositionColorTexture.anisotropy = 0;
        batchPositionColorTexture.needsUpdate = true;
        this.renderer.initTexture(batchPositionColorTexture)
        this.copyTex2D(batchPositionColorTexture, this.positionColorRenderTarget, scissor, destTextureLayer)
        batchPositionColorTexture.dispose();


        const batchCovarianceTexture = new DataTexture(covarianceArray, this.textureSize, srcHeight, RGBAIntegerFormat, UnsignedIntType);
        batchCovarianceTexture.internalFormat = 'RGBA32UI';
        batchCovarianceTexture.generateMipmaps = false;
        batchCovarianceTexture.magFilter = NearestFilter;
        batchCovarianceTexture.minFilter = NearestFilter;
        batchCovarianceTexture.anisotropy = 0;
        batchCovarianceTexture.needsUpdate = true;
        this.renderer.initTexture(batchCovarianceTexture)
        this.copyTex2D(batchCovarianceTexture, this.covarianceRenderTarget, scissor, destTextureLayer)
        batchCovarianceTexture.dispose();

    }

    growTextures() {

        //const start = performance.now();
        for (let i = this.maxSplats; i < this.maxSplats + (this.textureSize * this.textureSize); i += this.batchSize) {
            this.freeAddresses.add(i);
        }
        this.maxSplats += (this.textureSize * this.textureSize);



        const newNumTextures = this.numTextures + 1;
        const positionColorRenderTarget = new WebGL3DRenderTarget(this.textureSize, this.textureSize, newNumTextures, {
            magFilter: NearestFilter,
            minFilter: NearestFilter,
            type: UnsignedIntType,
            format: RGBAIntegerFormat,
            anisotropy: 0,
            depthBuffer: false,
            resolveDepthBuffer: false,
        })
        positionColorRenderTarget.texture.type = UnsignedIntType;
        positionColorRenderTarget.texture.internalFormat = 'RGBA32UI';
        positionColorRenderTarget.texture.format = RGBAIntegerFormat;   // ← add

        this.renderer.initRenderTarget(positionColorRenderTarget);
        this.copyTex3D(this.positionColorRenderTarget.texture, positionColorRenderTarget, this.numTextures);
        this.positionColorRenderTarget.dispose();
        this.positionColorRenderTarget = positionColorRenderTarget;
        this.material.uniforms.positionColorTexture.value = this.positionColorRenderTarget.texture;


        const covarianceRenderTarget = new WebGL3DRenderTarget(this.textureSize, this.textureSize, newNumTextures, {
            magFilter: NearestFilter,
            minFilter: NearestFilter,
            anisotropy: 0,
            type: UnsignedIntType,
            format: RGBAIntegerFormat,
            depthBuffer: false,
            resolveDepthBuffer: false,
        })

        covarianceRenderTarget.texture.type = UnsignedIntType;        // not FloatType!
        covarianceRenderTarget.texture.internalFormat = 'RGBA32UI';
        covarianceRenderTarget.texture.format = RGBAIntegerFormat;     // ← add

        this.renderer.initRenderTarget(covarianceRenderTarget);
        this.copyTex3D(this.covarianceRenderTarget.texture, covarianceRenderTarget, this.numTextures);
        this.covarianceRenderTarget.dispose();
        this.covarianceRenderTarget = covarianceRenderTarget;
        this.material.uniforms.covarianceTexture.value = this.covarianceRenderTarget.texture;



        this.numTextures = newNumTextures;
        this.material.uniforms.numSlices.value = this.numTextures;

        //console.log("grow " + (performance.now() - start) + " ms")
    }

} export { SplatsMesh }

function saveBuffer(pixelBuffer) {
    const canvas = document.createElement('canvas');
    const width = 512;
    const height = 512;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const imageData = context.createImageData(width, height);

    // WebGL's coordinate system is bottom-left, so we need to flip the image vertically
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const srcIndex = (y * width + x) * 4;
            const destIndex = ((height - y - 1) * width + x) * 4;
            imageData.data[destIndex] = pixelBuffer[srcIndex];       // R
            imageData.data[destIndex + 1] = pixelBuffer[srcIndex + 1]; // G
            imageData.data[destIndex + 2] = pixelBuffer[srcIndex + 2]; // B
            imageData.data[destIndex + 3] = pixelBuffer[srcIndex + 3]; // A
        }
    }
    context.putImageData(imageData, 0, 0);

    // 6. Convert the canvas to a PNG and trigger download
    canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `layer_.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }, 'image/png');
}
export function splatsVertexShader() {
    return `
precision highp float;
precision highp int;
precision highp usampler3D;

#include <common>
#include <packing>

uniform float textureSize;
uniform float numSlices;
uniform float sizeMultiplier;
in highp uint order;
out vec4 color;
out vec2 vUv;
out vec3 splatPositionWorld;
out vec3 splatPositionModel;
out float splatDepth;
//out float orthographicDepth;
out float stds;
uniform highp usampler3D positionColorTexture;
uniform highp usampler3D covarianceTexture;
uniform mat3 zUpToYUpMatrix3x3;
uniform float logDepthBufFC;
//uniform float cameraNear;
//uniform float cameraFar;
//uniform bool computeLinearDepth;
uniform vec2 viewportPixelSize;        // vec2(width , height)
uniform float k;
uniform float beta_k; // pow((4.0 * gamma(2.0/k)) /k, k/2)
uniform float minSplatPixelSize;
uniform float minOpacity;
uniform bool culling;
uniform float antialiasingFactor;


void getVertexData(out vec3 position, out mat3 covariance) {
    /* float index = float(order)+0.1; // add small offset to avoid floating point errors with modulo
    float pixelsPerSlice = textureSize * textureSize;
    float sliceIndex = floor(index / pixelsPerSlice);
    float slicePixelIndex = mod(index,pixelsPerSlice);

    float x = mod(slicePixelIndex,textureSize);
    float y = floor(slicePixelIndex / textureSize);

    ivec3 coord = ivec3(
        int( (x + 0.5) ),              // x pixel
        int( (y + 0.5) ),              // y pixel
        int( sliceIndex + 0.5 ) );     // z slice */

    
    highp uint uOrder = order; // Use a local uint copy

    // It's good practice to ensure textureSize is treated as uint for these calcs
    uint uTextureSize = uint(textureSize); // textureSize uniform is float
    uint uPixelsPerSlice = uTextureSize * uTextureSize;

    uint sliceIndexVal = uOrder / uPixelsPerSlice;
    uint slicePixelIndex = uOrder % uPixelsPerSlice; // umod(uOrder, uPixelsPerSlice) also works

    uint xVal = slicePixelIndex % uTextureSize; // umod(slicePixelIndex, uTextureSize)
    uint yVal = slicePixelIndex / uTextureSize;

    // texelFetch takes ivec3 for coordinates, no +0.5 needed as these are direct integer indices
    ivec3 coord = ivec3(xVal, yVal, sliceIndexVal);

    // Position
    highp uvec4 positionColor = texelFetch(positionColorTexture, coord,0);
    position = vec3(uintBitsToFloat(positionColor.r),uintBitsToFloat(positionColor.g),uintBitsToFloat(positionColor.b));
    
    color = vec4( (positionColor.a & 255u),
                  (positionColor.a >> 8)  & 255u,
                  (positionColor.a >> 16) & 255u,
                  (positionColor.a >> 24) ) / 255.0;
    
    
    highp uvec4 cov = texelFetch(covarianceTexture, coord, 0);
    vec2 c0 = unpackHalf2x16(cov.r);
    vec2 c1 = unpackHalf2x16(cov.g);
    vec2 c2 = unpackHalf2x16(cov.b);
    covariance = mat3(c0.x, c0.y, c1.x,
              c0.y, c1.y, c2.x,
              c1.x, c2.x, c2.y);


    //covariance *= 16.0;

    mat3 modelRotation = zUpToYUpMatrix3x3*transpose(mat3(modelMatrix));
    covariance = transpose(zUpToYUpMatrix3x3) * covariance * zUpToYUpMatrix3x3;
    covariance = transpose(modelRotation) * covariance * (modelRotation);
}

bool modelTransform(in vec3 splatWorld, in mat3 covariance, inout vec3 vertexPosition) {

    /* camera‑space Jacobian rows ----------------------------------------- */
    vec3 posCam = (viewMatrix * vec4(splatWorld, 1.0)).xyz;
    float invZ  = 1.0 / posCam.z;
    float invZ2 = invZ * invZ;
    float fx    = projectionMatrix[0][0];
    float fy    = projectionMatrix[1][1];

    vec3 j0 = vec3(fx * invZ,            0.0, -fx * posCam.x * invZ2);
    vec3 j1 = vec3(0.0,  fy * invZ, -fy * posCam.y * invZ2);

    mat3 viewRotT = transpose(mat3(viewMatrix));
    vec3 j0W = viewRotT * j0;
    vec3 j1W = viewRotT * j1;

    vec3 tmp0 = covariance * j0W;
    vec3 tmp1 = covariance * j1W;
    float a = dot(j0W, tmp0);
    float b = dot(j0W, tmp1);
    float c = dot(j1W, tmp1);
    float sigmaNDC = (antialiasingFactor / viewportPixelSize.x) * 2.0;
    float k2 = sigmaNDC * sigmaNDC;
    float detOrig = a * c - b * b;
    a += k2;
    c += k2;
    float detBlur = a * c - b * b;
    color.a *= sqrt(clamp(detOrig / detBlur, 0.0, 1.0-1.0e-6));
    if(color.a < 0.01) return false;
    //color.a = 1.0;
    float halfTrace = 0.5 * (a + c);
    float rootTerm  = sqrt(max(halfTrace * halfTrace - (a * c - b * b), 0.0));
    float lambda1   = halfTrace + rootTerm;
    float lambda2   = halfTrace - rootTerm;

    if(min(lambda2,lambda1)<=0.0) {
        return false;
    }
    


    vec2 eig1 = (abs(b) < 1e-7)
              ? ((a >= c) ? vec2(1.0, 0.0) : vec2(0.0, 1.0))
              : normalize(vec2(b, lambda1 - a));
    vec2 eig2 = vec2(-eig1.y, eig1.x);

    eig1 *= sqrt(lambda1) * 2.0;
    eig2 *= sqrt(lambda2) * 2.0;

    float alpha = dot(j0, j0);
    float beta  = dot(j0, j1);
    float gamma = dot(j1, j1);
    float invDet = 1.0 / (alpha * gamma - beta * beta);

    vec3 deltaCam1 = ( gamma * eig1.x - beta * eig1.y) * j0 +
                     (-beta * eig1.x + alpha * eig1.y) * j1;
    vec3 deltaCam2 = ( gamma * eig2.x - beta * eig2.y) * j0 +
                     (-beta * eig2.x + alpha * eig2.y) * j1;
    deltaCam1 *= invDet*0.5;
    deltaCam2 *= invDet*0.5;

    vec3 axisW1 = viewRotT * deltaCam1;
    vec3 axisW2 = viewRotT * deltaCam2;

    vertexPosition = vertexPosition.x * axisW1 + vertexPosition.y * axisW2;
    return true;
}


void main() {
    vUv = vec2(position);

    splatPositionModel = vec3(0.0);
    mat3 covariance = mat3(0.0);
    getVertexData(splatPositionModel, covariance);
    
    /* opacity ‑> stds */
    float maxV     = min(1.0,max(color.a, 0.0001));
    float thresh     = min(minOpacity, maxV);
    if(thresh >= maxV) return;
    float lnRatio = log(thresh/maxV);
    stds      = pow(-8.0 * lnRatio/beta_k, 1.0/k);//sqrt(2.0 * log(maxV / thresh));
    

    splatPositionWorld = (modelMatrix * vec4(splatPositionModel, 1.0)).xyz;
    vec4 splatPositionProjected = projectionMatrix * viewMatrix * vec4(splatPositionWorld, 1.0);

    if(culling){
        float clip = 1.2 * splatPositionProjected.w;
        if (splatPositionProjected.z < -splatPositionProjected.w || splatPositionProjected.x < -clip || splatPositionProjected.x > clip || splatPositionProjected.y < -clip || splatPositionProjected.y > clip) {
            gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
            return;
        }
    }
    

    vec3 offsetWorld = vec3(position)*sizeMultiplier*0.5*stds;
    
    bool valid = modelTransform(splatPositionWorld, covariance, offsetWorld);
    if(!valid) return;
    
    vec4 outPosition = projectionMatrix * viewMatrix * vec4(offsetWorld+splatPositionWorld,1.0);
    
    
    
    gl_Position = outPosition;
    /* if(computeLinearDepth){
        orthographicDepth = viewZToOrthographicDepth( -gl_Position.w, cameraNear, cameraFar );
    } */
    
    #if defined( USE_LOGDEPTHBUF )
	    float isPerspective = float( isPerspectiveMatrix( projectionMatrix ) );
        splatDepth = isPerspective == 0.0 ? splatPositionProjected.z : log2( 1.0 + splatPositionProjected.w ) * logDepthBufFC * 0.5;
    #else
        splatDepth = (splatPositionProjected.z / splatPositionProjected.w)* 0.5 + 0.5;
    #endif

    
}
`};
export function splatsFragmentShader() {
    return `
precision highp float;
precision highp int;

in float stds;
in vec4 color;
in vec2 vUv;
in vec3 splatPositionModel;
in vec3 splatPositionWorld;
in float splatDepth;

layout(location = 0) out vec4 fragColor;

uniform float textureSize;

uniform float k;
uniform float beta_k; // pow((4.0 * gamma(2.0/k)) /k, k/2)

void main() {
    float l = dot(vUv, vUv);
    if (l > 0.25) discard;           // early out unchanged
    vec2  p   = vUv * stds;
    float r2  = dot(p, p);           // r²
    float rk  = pow(r2, 0.5 * k);    // r^{k}
    float alpha = color.w * exp(-beta_k * rk);

    fragColor = vec4(pow(color.xyz,vec3(1.0/2.2)), alpha);
    
    //gl_FragDepth = splatDepth;
    
}`
};

function vertexCopyShader() {
    return `

precision highp float;
precision highp int;

out vec2 vUv;

void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`
};

function fragmentCopyShader2D() {
    return `
precision highp float;
precision highp int;
precision highp usampler2D;

layout(location = 0) out highp uvec4 fragColor;
uniform highp usampler2D sourceTexture;

in vec2 vUv;

void main() {
    fragColor = texture( sourceTexture, vUv );
}`
};


function fragmentCopyShader3D() {
    return `
precision highp float;
precision highp int;
precision highp usampler3D;

layout(location = 0) out highp uvec4 fragColor;
uniform highp usampler3D sourceTexture;
uniform float w;

in vec2 vUv;

void main() {
    fragColor = texture( sourceTexture, vec3(vUv, w) );
}`
};