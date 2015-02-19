/**
 * Copyright 2014 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
module Shumway.AVM2.AS.flash.display {
  import assert = Shumway.Debug.assert;
  import assertUnreachable = Shumway.Debug.assertUnreachable;
  import somewhatImplemented = Shumway.Debug.somewhatImplemented;
  import throwError = Shumway.AVM2.Runtime.throwError;
  import asCoerceString = Shumway.AVM2.Runtime.asCoerceString;

  import ActionScriptVersion = flash.display.ActionScriptVersion;
  import AVM2 = Shumway.AVM2.Runtime.AVM2;

  import LoaderContext = flash.system.LoaderContext;
  import events = flash.events;

  import FileLoader = Shumway.FileLoader;
  import ILoadListener = Shumway.ILoadListener;
  import AbcFile = Shumway.AVM2.ABC.AbcFile;
  import SWFFile = Shumway.SWF.SWFFile;

  import enterTimeline = Shumway.AVM2.enterTimeline;
  import leaveTimeline = Shumway.AVM2.leaveTimeline;

  enum LoadStatus {
    Unloaded    = 0,
    Opened      = 1,
    Initialized = 2,
    Complete    = 3
  }

  enum LoadingType {
    External    = 0,
    Bytes       = 1
  }

  export class Loader extends flash.display.DisplayObjectContainer
                      implements IAdvancable, ILoadListener {

    static runtimeStartTime: number;
    private static _rootLoader: Loader;
    private static _loadQueue: Loader [];
    private static _embeddedContentLoadCount: number;

    /**
     * Creates or returns the root Loader instance. The loader property of that instance's
     * LoaderInfo object is always null. Also, no OPEN event ever gets dispatched.
     */
    static getRootLoader(): Loader {
      if (Loader._rootLoader) {
        return Loader._rootLoader;
      }
      var loader = new flash.display.Loader();
      // The root loader gets a default name, but it's not visible and hence the instance id must
      // not be used up.
      flash.display.DisplayObject._instanceID--;
      // The root loaderInfo's `loader` property is always null.
      loader._contentLoaderInfo._loader = null;
      Loader._rootLoader = loader;
      return loader;
    }

    static reset() {
      Loader._loadQueue.forEach(loader => loader.unload());
      Loader.classInitializer();
    }

    static classInitializer: any = function () {
      Loader._rootLoader = null;
      Loader._loadQueue = [];
      Loader.runtimeStartTime = 0;
      Loader._embeddedContentLoadCount = 0;
    };
    static initializer: any = function() {
      var self: Loader = this;
      display.DisplayObject._advancableInstances.push(self);
    };

    static classSymbols: string [] = null;
    static instanceSymbols: string [] = null;

    /**
     * In each turn of the event loop, Loader events are processed in two batches:
     * first INIT and COMPLETE events are dispatched for all active Loaders, then
     * OPEN and PROGRESS.
     *
     * A slightly weird result of this is that INIT and COMPLETE are dispatched at
     * least one turn later than the other events: INIT is dispatched after the
     * content has been created. That, in turn, happens under
     * `DisplayObject.performFrameNavigation` in reaction to enough data being
     * marked as available - which happens in the second batch of Loader event
     * processing.
     */
    static processEvents() {
      Loader.processEarlyEvents();
      Loader.processLateEvents();
    }
    private static processEarlyEvents() {
      var queue = Loader._loadQueue;
      for (var i = 0; i < queue.length; i++) {
        var instance = queue[i];
        release || assert(instance._loadStatus !== LoadStatus.Complete);
        var loaderInfo = instance._contentLoaderInfo;
        var imageSymbol = instance._imageSymbol;

        // For images, only dispatch INIT and COMPLETE once the image has been decoded.
        if (loaderInfo._file instanceof ImageFile) {
          if (!imageSymbol || !imageSymbol.ready || instance._queuedLoadUpdate) {
            continue;
          }
          release || assert(loaderInfo.bytesLoaded === loaderInfo.bytesTotal);
          instance._applyDecodedImage(imageSymbol);
          release || assert(instance._content);
        }

        if (instance._loadStatus === LoadStatus.Opened && instance._content) {
          enterTimeline("Loader.INIT");
          try {
            loaderInfo.dispatchEvent(events.Event.getInstance(events.Event.INIT));
          } catch (e) {
            console.warn('caught error under loaderInfo INIT event:', e);
          }
          leaveTimeline();
          instance._loadStatus = LoadStatus.Initialized;
          // Only for the root loader, progress events for the data loaded up until now are
          // dispatched here.
          if (instance === Loader._rootLoader) {
            enterTimeline("Loader.Progress", 'rootLoader');
            try {
              loaderInfo.dispatchEvent(new events.ProgressEvent(events.ProgressEvent.PROGRESS,
                                                                false, false,
                                                                loaderInfo.bytesLoaded,
                                                                loaderInfo.bytesTotal));
            } catch (e) {
              console.warn('caught error under loaderInfo PROGRESS event:', e);
            }
            leaveTimeline();
          }
        }

        if (instance._loadStatus === LoadStatus.Initialized &&
            loaderInfo.bytesLoaded === loaderInfo.bytesTotal) {
          queue.splice(i--, 1);
          release || assert(queue.indexOf(instance) === -1);
          instance._loadStatus = LoadStatus.Complete;
          enterTimeline("Loader.Complete");
          try {
            loaderInfo.dispatchEvent(events.Event.getInstance(events.Event.COMPLETE));
          } catch (e) {
            console.warn('caught error under loaderInfo COMPLETE event: ', e);
          }
          leaveTimeline();
        }
      }
    }

    private static processLateEvents() {
      var queue = Loader._loadQueue;
      for (var i = 0; i < queue.length; i++) {
        var instance = queue[i];
        release || assert(instance._loadStatus !== LoadStatus.Complete);

        var loaderInfo = instance._contentLoaderInfo;
        var update = instance._queuedLoadUpdate;
        var bytesTotal = loaderInfo._bytesTotal;
        if ((!update || !bytesTotal) && instance._loadStatus !== LoadStatus.Opened) {
          continue;
        }
        instance._queuedLoadUpdate = null;

        if (instance._loadStatus === LoadStatus.Unloaded) {
          // OPEN is only dispatched when loading external resources, not for loadBytes.
          if (instance._loadingType === LoadingType.External) {
            enterTimeline("Loader.Open");
            try {
              loaderInfo.dispatchEvent(events.Event.getInstance(events.Event.OPEN));
            } catch (e) {
              console.warn('caught error under loaderInfo OPEN event: ', e);
            }
            leaveTimeline();
          }
          // The first time any progress is made at all, a progress event with bytesLoaded = 0
          // is dispatched.
          enterTimeline("Loader.Progress");
          try {
            loaderInfo.dispatchEvent(new events.ProgressEvent(events.ProgressEvent.PROGRESS,
                                                              false, false, 0, bytesTotal));
          } catch (e) {
            console.warn('caught error under loaderInfo PROGRESS event: ', e);
          }
          leaveTimeline();
          instance._loadStatus = LoadStatus.Opened;
        }

        // TODO: The Flash player reports progress in 16kb chunks, in a tight loop right here.
        if (update) {
          instance._applyLoadUpdate(update);
          enterTimeline("Loader.Progress");
          try {
            loaderInfo.dispatchEvent(new events.ProgressEvent(events.ProgressEvent.PROGRESS,
                                                              false, false, update.bytesLoaded,
                                                              bytesTotal));
          } catch (e) {
            console.warn('caught error under loaderInfo PROGRESS event: ', e);
          }
          leaveTimeline();
        }
      }
    }

    constructor () {
      false && super();
      DisplayObjectContainer.instanceConstructorNoInitialize.call(this);

      this._content = null;
      if (Loader._rootLoader) {
        // Loader reserves the next instance ID to use for the loaded content.
        // This isn't needed for the first, root, loader, because that uses "root1" as the name.
        this._contentID = DisplayObject._instanceID++;
      } else {
        // The root loader itself doesn't get an ID.
        //DisplayObject._instanceID--;
      }
      this._contentLoaderInfo = new display.LoaderInfo(display.LoaderInfo.CtorToken);
      this._contentLoaderInfo._loader = this;

      var currentAbc = AVM2.currentAbc();
      if (currentAbc) {
        this._contentLoaderInfo._loaderUrl = (<LoaderInfo>currentAbc.env.loaderInfo).url;
      }

      this._fileLoader = null;
      this._loadStatus = LoadStatus.Unloaded;
    }

    _setStage(stage: Stage) {
      release || assert(this === Loader.getRootLoader());
      this._stage = stage;
    }

    _initFrame(advance: boolean) {
      // ...
    }

    _constructFrame() {
      if (this === Loader.getRootLoader() && this._content) {
        display.DisplayObject._advancableInstances.remove(this);
        this._children[0] = this._content;
        this._constructChildren();
        this._children.length = 0;
        return;
      }
      this._constructChildren();
    }

    addChild(child: DisplayObject): DisplayObject {
      throwError('IllegalOperationError', Errors.InvalidLoaderMethodError);
      return null;
    }

    addChildAt(child: DisplayObject, index: number): DisplayObject {
      throwError('IllegalOperationError', Errors.InvalidLoaderMethodError);
      return null;
    }

    removeChild(child: DisplayObject): DisplayObject {
      throwError('IllegalOperationError', Errors.InvalidLoaderMethodError);
      return null;
    }

    removeChildAt(index: number): DisplayObject {
      throwError('IllegalOperationError', Errors.InvalidLoaderMethodError);
      return null;
    }

    setChildIndex(child: DisplayObject, index: number): void {
      throwError('IllegalOperationError', Errors.InvalidLoaderMethodError);
    }

    // AS -> JS Bindings

    private _content: flash.display.DisplayObject;
    private _contentID: number;
    private _contentLoaderInfo: flash.display.LoaderInfo;
    private _uncaughtErrorEvents: flash.events.UncaughtErrorEvents;

    private _fileLoader: FileLoader;
    private _imageSymbol: BitmapSymbol;
    private _loadStatus: LoadStatus;
    private _loadingType: LoadingType;
    private _queuedLoadUpdate: LoadProgressUpdate;

    /**
     * No way of knowing what's in |data|, so do a best effort to print out some meaninfgul debug
     * info.
     */
    private _describeData(data: any): string {
      var keyValueParis = [];
      for (var k in data) {
        keyValueParis.push(k + ":" + StringUtilities.toSafeString(data[k]));
      }
      return "{" + keyValueParis.join(", ") + "}";
    }

    get content(): flash.display.DisplayObject {
      if (this._loadStatus === LoadStatus.Unloaded) {
        return null;
      }
      return this._content;
    }

    get contentLoaderInfo(): flash.display.LoaderInfo {
      return this._contentLoaderInfo;
    }

    _getJPEGLoaderContextdeblockingfilter(context: flash.system.LoaderContext): number {
      if (flash.system.JPEGLoaderContext.isType(context)) {
        return (<flash.system.JPEGLoaderContext>context).deblockingFilter;
      }
      return 0.0;
    }

    get uncaughtErrorEvents(): events.UncaughtErrorEvents {
      somewhatImplemented("public flash.display.Loader::uncaughtErrorEvents");
      if (!this._uncaughtErrorEvents) {
        this._uncaughtErrorEvents = new events.UncaughtErrorEvents();
      }
      return this._uncaughtErrorEvents;
    }

    load(request: flash.net.URLRequest, context?: LoaderContext): void {
      this.close();
      // TODO: clean up contentloaderInfo.
      this._contentLoaderInfo._url = request.url;
      this._applyLoaderContext(context);
      this._loadingType = LoadingType.External;
      this._fileLoader = new FileLoader(this);
      if (!release && traceLoaderOption.value) {
        console.log("Loading url " + request.url);
      }
      this._fileLoader.loadFile(request._toFileRequest());

      this._queuedLoadUpdate = null;
      release || assert(Loader._loadQueue.indexOf(this) === -1);
      Loader._loadQueue.push(this);
    }

    loadBytes(data: flash.utils.ByteArray, context?: LoaderContext) {
      this.close();
      // TODO: properly coerce object arguments to their types.
      // In case this is the initial root loader, we won't have a loaderInfo object. That should
      // only happen in the inspector when a file is loaded from a Blob, though.
      this._contentLoaderInfo._url = (this.loaderInfo ? this.loaderInfo._url : '') +
                                     '/[[DYNAMIC]]/' + (++Loader._embeddedContentLoadCount);
      this._applyLoaderContext(context);
      this._loadingType = LoadingType.Bytes;
      this._fileLoader = new FileLoader(this);
      this._queuedLoadUpdate = null;
      if (!release && traceLoaderOption.value) {
        console.log("Loading embedded symbol " + this._contentLoaderInfo._url);
      }
      // Just passing in the bytes won't do, because the buffer can contain slop at the end.
      this._fileLoader.loadBytes(new Uint8Array((<any>data).bytes, 0, data.length));

      release || assert(Loader._loadQueue.indexOf(this) === -1);
      Loader._loadQueue.push(this);
    }

    close(): void {
      var queueIndex = Loader._loadQueue.indexOf(this);
      if (queueIndex > -1) {
        Loader._loadQueue.splice(queueIndex, 1);
      }
      this._contentLoaderInfo.reset();
      if (!this._fileLoader) {
        return;
      }
      this._fileLoader.abortLoad();
      this._fileLoader = null;
    }

    _unload(stopExecution: boolean, gc: boolean): void {
      if (this._loadStatus < LoadStatus.Initialized) {
        this._loadStatus = LoadStatus.Unloaded;
        return;
      }
      this.close();
      this._content = null;
      this._contentLoaderInfo._loader = null;
      this._loadStatus = LoadStatus.Unloaded;
      this.dispatchEvent(events.Event.getInstance(events.Event.UNLOAD));
    }
    unload() {
      this._unload(false, false);
    }
    unloadAndStop(gc: boolean) {
      // TODO: remove all DisplayObjects originating from the unloaded SWF from all lists and stop
      // them.
      this._unload(true, !!gc);
    }

    private _applyLoaderContext(context: LoaderContext) {
      var parameters = {};
      if (context && context.parameters) {
        var contextParameters = context.parameters;
        for (var key in contextParameters) {
          var value = contextParameters[key];
          if (!isString(value)) {
            throwError('IllegalOperationError', Errors.ObjectWithStringsParamError,
                       'LoaderContext.parameters');
          }
          parameters[key] = value;
        }
      }
      if (context && context.applicationDomain) {
        var domain = new system.ApplicationDomain(system.ApplicationDomain.currentDomain);
        this._contentLoaderInfo._applicationDomain = domain;
      }
      this._contentLoaderInfo._parameters = parameters;
    }

    onLoadOpen(file: any) {
      this._contentLoaderInfo.setFile(file);
    }

    onLoadProgress(update: LoadProgressUpdate) {
      release || assert(update);
      this._queuedLoadUpdate = update;
    }

    onNewEagerlyParsedSymbols(dictionaryEntries: SWF.EagerlyParsedDictionaryEntry[],
                              delta: number): Promise<any> {
      var promises: Promise<any>[] = [];
      for (var i = dictionaryEntries.length - delta; i < dictionaryEntries.length; i++) {
        var dictionaryEntry = dictionaryEntries[i];
        var symbol = this._contentLoaderInfo.getSymbolById(dictionaryEntry.id);
        // JPEGs with alpha channel are parsed with our JS parser for now. They're ready
        // immediately, so don't need any more work here. We'll change them to using the system
        // parser, but for now, just skip further processing here.
        if (symbol.ready) {
          continue;
        }
        release || assert(symbol.resolveAssetPromise);
        release || assert(symbol.ready === false);
        promises.push(symbol.resolveAssetPromise.promise);
      }
      return Promise.all(promises);
    }

    onImageBytesLoaded() {
      var file = this._contentLoaderInfo._file;
      release || assert(file instanceof ImageFile);
      var data = {
        id: -1,
        data: file.data,
        mimeType: file.mimeType,
        dataType: file.type,
        type: 'image'
      };
      var symbol = BitmapSymbol.FromData(data);
      this._imageSymbol = symbol;
      var resolver: Timeline.IAssetResolver = AVM2.instance.globals['Shumway.Player.Utils'];
      resolver.registerFontOrImage(symbol, data);
      release || assert(symbol.resolveAssetPromise);
      release || assert(symbol.ready === false);
    }

    private _applyDecodedImage(symbol: BitmapSymbol) {
      var bitmapData = symbol.createSharedInstance();
      this._content = new flash.display.Bitmap(bitmapData);
      this._contentLoaderInfo._width = this._content.width * 20;
      this._contentLoaderInfo._height = this._content.height * 20;
      this.addTimelineObjectAtDepth(this._content, 0);
    }

    private _applyLoadUpdate(update: LoadProgressUpdate) {
      var loaderInfo = this._contentLoaderInfo;
      loaderInfo._bytesLoaded = update.bytesLoaded;
      var file = loaderInfo._file;

      if (!(file instanceof SWFFile)) {
        return;
      }

      if (file.framesLoaded === 0) {
        return;
      }

      if (loaderInfo._allowCodeExecution) {
        var appDomain = AVM2.instance.applicationDomain;

        var abcBlocksLoaded = file.abcBlocks.length;
        var abcBlocksLoadedDelta = abcBlocksLoaded - loaderInfo._abcBlocksLoaded;
        if (abcBlocksLoadedDelta > 0) {
          for (var i = loaderInfo._abcBlocksLoaded; i < abcBlocksLoaded; i++) {
            var abcBlock = file.abcBlocks[i];
            var abc = new AbcFile(abcBlock.data, abcBlock.name);
            abc.env.loaderInfo = loaderInfo;
            if (abcBlock.flags) {
              // kDoAbcLazyInitializeFlag = 1 Indicates that the ABC block should not be executed
              // immediately.
              appDomain.loadAbc(abc);
            } else {
              // TODO: probably delay execution until playhead reaches the frame.
              appDomain.executeAbc(abc);
            }
          }
          loaderInfo._abcBlocksLoaded = abcBlocksLoaded;
        }

        var mappedSymbolsLoaded = file.symbolClassesList.length;
        var mappedSymbolsLoadedDelta = mappedSymbolsLoaded - loaderInfo._mappedSymbolsLoaded;
        if (mappedSymbolsLoadedDelta > 0) {
          for (var i = loaderInfo._mappedSymbolsLoaded; i < mappedSymbolsLoaded; i++) {
            var symbolMapping = file.symbolClassesList[i];
            var symbolClass = appDomain.getClass(symbolMapping.className);
            Object.defineProperty(symbolClass, "defaultInitializerArgument",
                                  {get: loaderInfo.getSymbolResolver(symbolClass, symbolMapping.id),
                                   configurable: true});
          }
          loaderInfo._mappedSymbolsLoaded = mappedSymbolsLoaded;
        }
      }

      // In browsers that can't synchronously decode fonts, we have already registered all
      // embedded fonts at this point.
      if (inFirefox) {
        var fontsLoaded = file.fonts.length;
        var fontsLoadedDelta = fontsLoaded - loaderInfo._fontsLoaded;
        if (fontsLoadedDelta > 0) {
          for (var i = loaderInfo._fontsLoaded; i < fontsLoaded; i++) {
            flash.text.Font.registerEmbeddedFont(file.fonts[i], loaderInfo);
          }
          loaderInfo._fontsLoaded = fontsLoaded;
        }
      }

      var rootSymbol = loaderInfo.getRootSymbol();
      var framesLoadedDelta = file.framesLoaded - rootSymbol.frames.length;
      if (framesLoadedDelta === 0) {
        return;
      }
      var root = this._content;
      if (!root) {
        root = this.createContentRoot(rootSymbol, file.sceneAndFrameLabelData);
      }
      var rootSprite = <Sprite><any>root;
      for (var i = 0; i < framesLoadedDelta; i++) {
        var frameInfo = loaderInfo.getFrame(null, rootSymbol.frames.length);
        rootSprite._addFrame(frameInfo);
      }
    }

    onLoadComplete() {
      // Go away, tslint.
    }
    onLoadError() {
      release || Debug.warning('Not implemented: flash.display.Loader loading-error handling');
    }

    private createContentRoot(symbol: SpriteSymbol, sceneData) {
      if (symbol.isAVM1Object) {
        this._initAvm1(symbol);
      }
      var root = symbol.symbolClass.initializeFrom(symbol);
      // The initial SWF's root object gets a default of 'root1', which doesn't use up a
      // DisplayObject instance ID. For the others, we have reserved on in `_contentID`.
      flash.display.DisplayObject._instanceID--;
      if (this === Loader._rootLoader) {
        root._name = 'root1';
      } else {
        root._name = 'instance' + this._contentID;
      }

      if (MovieClip.isType(root)) {
        var mc = <MovieClip>root;
        if (sceneData) {
          var scenes = sceneData.scenes;
          for (var i = 0, n = scenes.length; i < n; i++) {
            var sceneInfo = scenes[i];
            var offset = sceneInfo.offset;
            var endFrame = i < n - 1 ? scenes[i + 1].offset : symbol.numFrames;
            mc.addScene(sceneInfo.name, [], offset, endFrame - offset);
          }
          var labels = sceneData.labels;
          for (var i = 0; i < labels.length; i++) {
            var labelInfo = labels[i];
            mc.addFrameLabel(labelInfo.name, labelInfo.frame + 1);
          }
        } else {
          mc.addScene('Scene 1', [], 0, symbol.numFrames);
        }
      }

      var loaderInfo = this._contentLoaderInfo;
      root._loaderInfo = loaderInfo;
      var rootTimeline = root;
      if (loaderInfo.actionScriptVersion === ActionScriptVersion.ACTIONSCRIPT2) {
        root = this._initAvm1Root(root);
      } else if (this === Loader.getRootLoader()) {
        display.MovieClip.frameNavigationModel = loaderInfo.swfVersion < 10 ?
                                                 flash.display.FrameNavigationModel.SWF9 :
                                                 flash.display.FrameNavigationModel.SWF10;
      }
      this._content = root;
      if (this === Loader.getRootLoader()) {
        Loader.runtimeStartTime = Date.now();
        this._stage.setRoot(root);
      } else {
        this.addTimelineObjectAtDepth(root, 0);
      }
      // Always return the non-wrapped MovieClip instead of AVM1Movie for AVM1 SWFs.
      return rootTimeline;
    }

    private _initAvm1(symbol: SpriteSymbol): void {
      var contentLoaderInfo: LoaderInfo = this._contentLoaderInfo;
      var context;
      // Only the outermost AVM1 SWF gets an AVM1Context. SWFs loaded into it share that context.
      if (this.loaderInfo && this.loaderInfo._avm1Context) {
        context = contentLoaderInfo._avm1Context = this.loaderInfo._avm1Context;
      } else {
        Shumway.AVM1.Lib.installObjectMethods();
        context = Shumway.AVM1.AVM1Context.create(contentLoaderInfo);
        contentLoaderInfo._avm1Context = context;
        if (this === Loader.getRootLoader()) {
          context.globals.Key._bind(this._stage, context);
          context.globals.Mouse._bind(this._stage, context);
          display.MovieClip.frameNavigationModel = flash.display.FrameNavigationModel.SWF1;
        }
      }
      symbol.avm1Context = context;
    }

    /**
     * For AVM1 SWFs that aren't loaded into other AVM1 SWFs, create an AVM1Movie container
     * and wrap the root timeline into it. This associates the AVM1Context with this AVM1
     * MovieClip tree, including potential nested SWFs.
     */
    private _initAvm1Root(root: flash.display.DisplayObject) {
      var avm1Context = this._contentLoaderInfo._avm1Context;
      var as2Object = Shumway.AVM1.Lib.getAVM1Object(root, avm1Context);

      // Only create an AVM1Movie container for the outermost AVM1 SWF. Nested AVM1 SWFs just get
      // their content added to the loading SWFs display list directly.
      if (this.loaderInfo && this.loaderInfo._avm1Context) {
        as2Object.context = this.loaderInfo._avm1Context;
        return root;
      }

      avm1Context.root = as2Object;
      root.addEventListener('frameConstructed',
                            avm1Context.flushPendingScripts.bind(avm1Context),
                            false,
                            Number.MAX_VALUE);

      var avm1Movie = new flash.display.AVM1Movie(<MovieClip>root);

      // transfer parameters
      var parameters = this._contentLoaderInfo._parameters;
      for (var paramName in parameters) {
        if (!(paramName in as2Object)) { // not present yet
          as2Object[paramName] = parameters[paramName];
        }
      }

      return avm1Movie;
    }
  }
}
