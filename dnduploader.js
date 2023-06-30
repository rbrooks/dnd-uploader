(function($) {
    // `const` not supported in IE, but neither are DnD uploads.
    const CHUNK_SIZE = 256 * 1024; // 256K chunk size.
    // Do not raise CHUNK_SIZE greater than Nginx's client_body_buffer_size
    // or uploads resumed more than 5 or 6 times will be corrupt.  Nginx's
    // client_body_buffer_size is also set to 256K.  256K, on both Client and
    // Server sides, yielded the best upload performance.  Setting any higher
    // or lower degraded performance.
  
    var filenames = [];
    var fileArray = [];
    var fileList = [];
    var chunkStart = [];
    var chunkEnd = [];
    var folderUploadsSupported = false;
    var droppedAtLeastOneFolder = false;
    var videoTsFolders = 0;
    var inProgress = 0;
    var succeeded = 0;
    var failed = 0;
    var delayedJobNotification = false;
    var resumableSupported = false;
    var firstAssetName = '';
    var dropElement;
  
    var methods = {
      init : function(options) {
        return this.each(function() {
          $(this).data('options', options);
          $(this).on('dragenter.dndUploader', methods.dragEnter);
          $(this).on('dragover.dndUploader', methods.dragOver);
          $(this).on('drop.dndUploader', methods.drop);
          dropElement = $(this);
        });
      },
  
      dragEnter : function(event) {
        event.stopPropagation();
        event.preventDefault();
      },
  
      dragOver : function(event) {
        event.stopPropagation();
        event.preventDefault();
        event.originalEvent.dataTransfer.dropEffect = 'copy';
      },
  
      drop : function(event) {
        event.stopPropagation();
        event.preventDefault();
        // Prevent the user from dropping more items while files are uploading
        $(this).unbind('drop.dndUploader');
  
        // Prevent key presses in Search box while upload in progress. They compromise
        // chunked uploads in FF, but interrupting them with AJAX search calls.
        $('input#search').attr('disabled', 'disabled');
  
        var options = $(this).data('options');
        var dataTransfer = event.originalEvent.dataTransfer;
        var err = false;
        var isReplacementUpload = ('medium' in options.uploadParams && 'id' in options.uploadParams.medium);
  
        if (isReplacementUpload) {
          if (confirm('Replacement upload. This will irrecoverably overwrite this video. Are you sure you want to do this?') == false) {
            document.location.reload(true);
            return false;
          }
        }
  
        folderUploadsSupported = (dataTransfer.items && dataTransfer.items[0].webkitGetAsEntry());
  
        if (folderUploadsSupported) {
          for (var i = 0; i < dataTransfer.items.length; i++) {
            if (dataTransfer.items[i].webkitGetAsEntry().isDirectory) {
              droppedAtLeastOneFolder = true;
            }
            if (dataTransfer.items[i].webkitGetAsEntry().name.match(/^VIDEO_TS$/i) != null) {
              // Connect doesn't support accepting multiple, simultaneous DVDs,
              // or a mix of a DVD uploads and single files.
              videoTsFolders++;
  
              if (videoTsFolders > 0 && dataTransfer.items.length > 1) {
                alert('Please upload one VIDEO_TS folder at a time, and not in combination with any other files.');
                err = true;
                document.location.reload(true);
              }
            }
          }
        }
  
        if (!err) {
          openPanel(function() {
            initUpload(options, event);
          });        
        }
      }
    };
  
    function toArray(list) {
      return Array.prototype.slice.call(list || [], 0);
    }
  
    function initUpload(options, event) {
      var dataTransfer = event.originalEvent.dataTransfer;
  
      if (inProgress === 0) resetProgressDisplay();
  
      $('#panel #close').click(function(e) {
         // Make Close button refresh the page so it stops all uploads in progress.
        e.preventDefault();
        closePanel();
        options.onError();
        notify("upload action stopped");
        document.location.reload(true);
      });      
  
      if (folderUploadsSupported && droppedAtLeastOneFolder) {
        var itemsRead = 0;
  
        readFoldersAndFiles(dataTransfer, function(totalItemsDropped) {
          itemsRead++;
          var lastFile = (itemsRead == totalItemsDropped);
  
          if (lastFile) startUpload(dataTransfer, options);
        });
      } else {
        startUpload(dataTransfer, options);
      }
    }
  
    function readFoldersAndFiles(dataTransfer, callback) {
      var items = dataTransfer.items;
  
      for (var i = 0, totalItemsDropped = items.length; i < items.length; i++) {
        var entry = items[i].webkitGetAsEntry();
  
        if (items[i].kind != 'file') {
          // Restart loop (skip this one) if it isn't a 'file' kind.
          // Directories and files are both a 'file' kind.
          continue;
        }
  
        if (entry.isDirectory) {
          var dirReader = entry.createReader();
  
          var readEntries = function(totalItemsDropped) {
            dirReader.readEntries(function(entries) { // WARNING! Async. Snaps into background.
              $.each(entries, function(idx, entry) {
                var lastTime = (idx == entries.length - 1);
  
                if (entry.isFile) { // Do not recurse into subfolders.
                  entry.file(function(file) { // WARNING! Asynchronous.
                    if (file.name == 'desktop.ini' || file.name.match(/^\./) != null) {
                      // Skip hidden dot files and Windows desktop.ini files.
                      if (lastTime) callback(totalItemsDropped);
                      return;
                    }
  
                    if (fileList instanceof Array == false && idx <= 0) {
                      // The reason for this unsightly validation:
                      // Chrome 21 on Windows (all versions) has a bug (but only sometimes):
                      // When a folder containing subfolders is dropped, it is bizarrely converts
                      // our fileList array into an actual FileList object. Then the push() method
                      // below of course, fails.  push() only works on arrays, not Objects. It's not
                      // a naming conflict.  It doesn't matter what we name it: foo, fileList2, etc.
                      // Place a console.log(fileList) line between every line of this file,
                      // then monitor the Chrome Dev Tools console on OS X and Windows. On OS X, you
                      // will see it remain an Array the entire time.  On Windows, you will see it
                      // transform itself from Array to FileList between two arbitrary lines of code.
                      // It happens at a random time during these loops, so it is impossible to
                      // determine which line is causing it, if any. So this alert box should only
                      // ever appear on Windows.
                      alert('Please drop a folder that contains files only; no subfolders.');
                      document.location.reload(true);
                      return false;
                    }
  
                    fileList.push(file);
  
                    if (lastTime) callback(totalItemsDropped);
                  }, errorHandler);
                } else {
                  if (lastTime) callback(totalItemsDropped);
                }
              });
            }, errorHandler);
          };
  
          readEntries(totalItemsDropped);
        } else {
          var file = items[i].getAsFile();
  
          fileList.push(items[i].getAsFile());
  
          callback(totalItemsDropped);
        }
      }
    }
  
    function startUpload(dataTransfer, options) {
      if (fileList.length == 0) {
        // dataTransfer.files is a read-only FileList object, which is a hash table of File objects.
        fileList = dataTransfer.files;
      }
  
      if (fileList.length > 0) {
        var batch = dvdBatch(fileList);
  
        if (batch.hasValidDvdFiles()) {
          inProgress = 1;
          uploadDvdBatch(batch, options);
        } else {
          inProgress = fileList.length;
          uploadFiles(fileList, options);
        }
      };
  
      $('.scrollbar').scrollbar(); // Don't move this. It must stay right here.
    }
  
    function uploadDvdBatch(batch, options) {
      var batchName = 'DVD Files';
      var files = batch.storableFiles();
      var validation = validateDvdFiles(files, options);
  
      if (validation.isValid()) {
        firstAssetName = batchName;
        prepareFormData(0, files, 'files[]', options.dvdUrl, options, batchName);
      } else {
        validationFailure(0, batchName, validator.errors());
      }
    }
  
    function uploadFiles(files, options) {
      if(options['maxUploadCount'] && options['maxUploadCount'] > 0 && files.length > options['maxUploadCount']) {
        return validationFailure(0, 'Uploaded files', 'A maximum of ' + options['maxUploadCount'] + ' files can be uploaded at one time. Please reduce the number and try again.');
      }
      if(!options['allowMultipleMedia'] && files.length > 1) {
        return validationFailure(0, 'Uploaded files', 'Please upload only one video. Multiple files are allowed only if they are part of a DVD.');
      }
  
      $.each(files, function(id, file) {
        chunkStart[id] = 0;
        chunkEnd[id] = 0;
  
        var validator = mediaFileValidator(file.name, file.size, options);
  
        if (validator.isValid()) {
          firstAssetName = file.name;
          prepareFormData(id, file, 'files[]', options.fileUrl, options);
        } else {
          validationFailure(id, validator.fileName, validator.errors());
        }
      });
    }
  
    function resetProgressDisplay() {
      // Reinitialize attributes set in the last upload.
      filenames = [];
      inProgress = 0;
      succeeded = 0;
      failed = 0;
      delayedJobNotification = false;
      // Remove all dynamic UI elements left over from previous operations, and initialize a new progress container.
      $('#panel').html(
        '<div id="panel_close"><a href="#" id="close"><img src="/images/icon_close2.png" width="15" height="16" title="Close" alt="X" /></a></div>' +
        '<div class="scrollbar">' +
        '  <p id="blurb" style="float: left; margin-bottom: 10px;">Reloading page cancels uploads.</p>' +
        '</div>'
      );
      $('#panel .scrollbar').append('<div id="progress_container"></div>');
      $('#panel .scrollbar #progress_container').show();
    }
  
    function prepareFormData(id, file, fileParam, url, options, batchName) {
      addBar(id, '#panel .scrollbar #progress_container');
      $('.scrollbar').scrollbar('repaint');
  
      var data = new FormData(); // FormData object. Only modern browsers support it: FF, Chrome, Safari.
  
      if ($.isArray(file)) {
        $.each(file, function(id, f) {
          data.append(fileParam, f);
        });
      } else {
        data.append(fileParam, file);
      }
  
      addCsrfToken(data);
  
      addNewEpisodeFormData(data);
  
      if (options.uploadParams) {
        for(var key in options.uploadParams) {
          var value = options.uploadParams[key];
          if(typeof(value) === 'object') {
            for(var key2 in value) {
              data.append(key + '[' + key2 + ']', value[key2]);
            }
          } else data.append(key, value);
        }
      }
  
      if ($.isArray(file)) {
        filenames[id] = ((batchName) ? batchName : file);
      } else {
        filenames[id] = ((batchName) ? batchName : file.name);
      }
  
      resumableSupported = (!options.disableResumable && !!window.File && !!window.FileList && !!window.FileReader && ('mozSlice' in file || 'webkitSlice' in file || 'slice' in file));
  
      if (resumableSupported && batchName === undefined) {
        $('#panel #blurb:not(:contains("Upload is resumable."))').append(' Upload is resumable.');
        resumableUpload(id, file, url, options);
      } else {
        upload(id, data, url, options);
      }
    }
  
    function upload(id, data, url, options) {
      var xhr = new XMLHttpRequest();
  
      xhr.addEventListener('error', function(event) { xhrError(xhr) }, false);
      xhr.addEventListener('readystatechange', function(event) { uploadReadyState(xhr, id, options) }, false);
      xhr.upload.addEventListener('progress', function(event) {
        updateProgress(id, event.lengthComputable ? event.loaded / event.total : 0, filenames[id]);
      }, false);
      xhr.upload.addEventListener('error', uploadError, false);
  
      xhr.open('POST', url);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.send(data);
    }
  
    function resumableUpload(id, file, url, options) {
      // Resumable hotness
      url += '.json?resumable=true';
      if (options.series_id) url += '&series_id=' + options.series_id;
  
      if (options.uploadParams) {
        for(var key in options.uploadParams) {
          var value = options.uploadParams[key];
          if(typeof(value) === 'object') {
            for(var key2 in value) {
              url += '&' + key + '[' + key2 + ']=' + value[key2];
            }
          } else url += '&' + key + '=' + value;
        }
      }
  
      window.BlobBuilder = window.MozBlobBuilder || window.WebKitBlobBuilder || window.BlobBuilder;
      const FILE_SIZE = file.size;
      var bytesUploaded = 0;
      var isFinalChunk;
      var chunk;
  
      var sendChunk = function() {
        if (chunkStart[id] == 0 && chunkEnd[id] == 0) { // Calc first chunk.
          calcNextChunkRanges(id, FILE_SIZE, xhr);
        }
  
        if ('slice' in file) {
          chunk = file.slice(chunkStart[id], chunkEnd[id] + 1);
        } else if ('webkitSlice' in file) {
          chunk = file.webkitSlice(chunkStart[id], chunkEnd[id] + 1);
        } else if ('mozSlice' in file) {
          chunk = file.mozSlice(chunkStart[id], chunkEnd[id] + 1);
        } else {
          // Browser doesn't support chunking.
          return false;
        }
  
        var xhr = new XMLHttpRequest();
        xhr.addEventListener('readystatechange', function(event) { resumableReadyState(xhr, id) }, false);
        xhr.addEventListener('error', function(event) { xhrError(xhr) }, false);
        xhr.upload.addEventListener('error', uploadError, false);
  
        xhr.open('POST', url);
  
        // Resumable chunks must be synchronous, because the "next chunk" calculation depends upon what
        // Nginx returns in the Range header or the previous chunk, and because we must be able
        // to stop all chunks from being sent when one request fails.  We can't simply
        // use the `async = false` 3rd param on open() because, although that succeeds in uploading
        // the chunks, it blocks the entire UI while doing so [JS being single-threaded].
        // So we leave XHR in its default async mode, but achieve synchronicity with a
        // recursive function. Now the UI works and chunks are properly strung together.
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
        xhr.setRequestHeader('Content-Disposition', 'attachment; filename="' + file.name + '"');
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('Session-Id', options.userId + '-' + MD5(file.name));
        xhr.setRequestHeader('X-Content-Range', 'bytes ' + chunkStart[id] + '-' + chunkEnd[id] + '/' + FILE_SIZE);
        // X-Content-Range:
        //   * Is always 1 byte less than actual Content-Length sent, even the final chunk.
        //   * Never overlap. Subsequent chunk starts 1 byte after end of last chunk.
        // slice(), mozSlice(), webkitSlice():
        //   * These determine Content-Length.
        //   * Start of subsequent chunk and End of last are identical.
  
        xhr.send(chunk);
  
        function resumableReadyState(xhr, id) {
          if (xhr.readyState == 4) {
            if (xhr.status == 200 || xhr.status == 201) {
              bytesUploaded = calcNextChunkRanges(id, FILE_SIZE, xhr);
              isFinalChunk = (xhr.getResponseHeader('Range') === null);
  
              if (isFinalChunk) {
                uploadSuccess(id, xhr);
                showSummary(options, xhr);
              } else {
                updateProgress(id, bytesUploaded / FILE_SIZE, filenames[id]);
                sendChunk(); // Recurse
              }
            } else {
              uploadFailure(id, xhr);
              showSummary(options, xhr);
              return false; // Break out of loop. Don't send any more chunks.
            }
          }
        }
      };
  
      sendChunk(); // Start upload.
    }
  
    function uploadReadyState(xhr, id, options) {
      // Callback to handle asynchronous-upload completion (non-resumable).
      // Fires every time XHR State changes, which is 4 times throughout the life cycle of a successful request.
      // The readyState property returns a value from 0 to 4:
      //   0: request not initialized
      //   1: server connection established
      //   2: request received
      //   3: processing request
      //   4: request finished and response is ready
      if (xhr.readyState == 4) {
        if (xhr.status == '202') delayedJobNotification = true;
  
        if (xhr.status == '200' || xhr.status == '201' || xhr.status == '202') {
          uploadSuccess(id, xhr);
        } else {
          uploadFailure(id, xhr);
        }
        showSummary(options, xhr);
      }
    }
  
    function uploadSuccess(id, xhr) {
      inProgress--;
      succeeded++;
      successBar(id, filenames[id]);
      // Intentionally no scrollbar repaint here. Success bars cannot have extra vertical space.
    }
  
    function uploadFailure(id, xhr) {
      inProgress--;
      failed++;
      var errMsg;
  
      if (xhr.status == 422) { // 422 HTTP error is 'Unprocessable Entity' and is validation failure in Rails.
        errors = $.parseJSON(xhr.responseText).errors;
        errMsg = errors ? ('Error: ' + errors.join(', ')) : "Error queuing file for processing.";
      } else {
        // Unexpected error. Just display HTTP status text for now, although should probably be something friendlier.
        errMsg = xhr.statusText;
      }
      errorBar(id, '#panel .scrollbar #progress_container', filenames[id], errMsg);
      $('.scrollbar').scrollbar('repaint'); // Do not remove this. Scrollbar must be repainted after failures only.
      // Failure bars can have more vertical space because of error messaging below them. Success bars can't.
    }
  
    function validationFailure(id, fileName, errMsg) {
      inProgress--;
      failed++;
  
      errorBar(id, '#panel .scrollbar #progress_container', fileName, errMsg);
      $('.scrollbar').scrollbar('repaint'); // Do not remove this.
    }
  
    function showSummary(options, xhr) {
      if (inProgress < 1) {
        var blurb = '';
  
        if (succeeded > 0) {
          if (succeeded > 1) {
            blurb += '<strong>' + succeeded + ' uploads succeeded.</strong> ';
          } else {
            blurb += '<strong>1 upload succeeded.</strong> ';
          }
          if (delayedJobNotification) {
            blurb += ' <br />DVD files have been queued for processing.';
            blurb += ' Visit the <a href="/activities">activity page</a>';
            blurb += ' to check processing status.';
          } else if (failed > 0) {
            blurb += '<strong>' + failed + ' failed.</strong><br />Refresh page or close this panel.';
            $('#panel #close').click(function(e) {
              // Rewire default Close event to refresh the page, so the user can see the ones that did upload.
              e.preventDefault();
              closePanel();
              options.onError();
              document.location.reload(true);
            });
            notify("upload action stopped");
          }
        } else if (failed > 0) {
          blurb = 'Uploads failed.';
          $('#panel #close').click(function(e) {
            e.preventDefault();
            closePanel();
            document.location.reload(true);
          });
          notify("upload action stopped");
        }
  
        $('#panel #blurb').html(blurb);
  
        if (failed == 0 && !delayedJobNotification) {
          var assetIds;
          try {
            assetIds = $.parseJSON(xhr.responseText).asset_ids;
          } catch(e) {
            assetIds = [];
          }
          if (assetIds) assetIds = assetIds.join(',');
  
          setTimeout(function() {
            closePanel();
            options.onComplete(assetIds, firstAssetName);
            populateNewEpisodeForm(xhr, firstAssetName);
          }, 1000);
  
          notify('upload action stopped');
        }
  
        $('.scrollbar').scrollbar('repaint');
      }
    }
  
    function calcNextChunkRanges(id, fileSize, xhr) {
      // Chunks do not need to be in sequence.
      var bytesUploaded = 0;
      chunkStart[id] = 0;
      chunkEnd[id] = ((chunkStart[id] + CHUNK_SIZE < fileSize) ? (chunkStart[id] + CHUNK_SIZE) : (fileSize - 1));
  
      if (xhr !== undefined) {
        if (xhr.getResponseHeader('Range') && xhr.getResponseHeader('Range').match(/^\d+-\d+\/\d+/)) {
          // Response can be 0-66211/6621184,6554988-6621183/6621184, so the
          // end-of-string matcher ($) is intentionally omitted from RegEx.
          var holeStart = 0, holeEnd = 0;
          // Find first hole in ranges.
          $.each(xhr.getResponseHeader('Range').split(','), function(i, str) {
            var r = str.split('/')[0].split('-');
            var start = parseInt(r[0]);
            var end = parseInt(r[1]);
            bytesUploaded += end - start;
  
            if (holeEnd != 0) return true; // Restart loop
  
            if (start != 0) {
              holeEnd = start - 1;
            } else {
              holeStart = end + 1;
            }
          });
          chunkStart[id] = holeStart;
          if (holeEnd == 0) {
            holeEnd = fileSize - 1;
          }
          chunkEnd[id] = ((holeEnd - holeStart < CHUNK_SIZE) ? holeEnd : (chunkStart[id] + CHUNK_SIZE));
        } else {
          // Final chunk has no Range header.
          bytesUploaded = fileSize;
        }
      }
      return bytesUploaded;
    }
  
    function uploadError() {
      console.log('Unknown upload error.');
    }
  
    function xhrError(xhr) {
      console.log('Unknown AJAX error: ' + xhr.statusText);
    }
  
    function validateDvdFiles(files, options) {
      var totalSize = 0;
      $.each(files, function(i, file) {
        totalSize += file.size;
      });
      return mediaFileValidator('DVD.mpg', totalSize, options);
    }
  
    function addCsrfToken(data) {
      var csrf_token = $('meta[name=csrf-token]').attr('content'),
      csrf_param = $('meta[name=csrf-param]').attr('content');
      if (csrf_param !== undefined && csrf_token !== undefined) {
        data.append(csrf_param, csrf_token);
      }
    }
  
    function populateNewEpisodeForm(xhr, firstAssetName) {
      if (window.location.href.indexOf('episodes/new') >= 0) {
        var mediaId = $.parseJSON(xhr.responseText).medium_id;
        var assetName = firstAssetName.substr(0, firstAssetName.indexOf('.'));
        assetName = assetName.replace('_', ' ');
  
        if ($.trim($('#episode_medium_attributes_title').val()) == '') $('#episode_medium_attributes_title').val(assetName);
        if ($.trim($('#episode_medium_attributes_short_summary').val()) == '') $('#episode_medium_attributes_short_summary').val(assetName);
  
        window.location.replace('./'); // Redirect one level up, back to Episodes index page.
      }
    }
  
    function addNewEpisodeFormData(data) {
      if (window.location.href.indexOf('episodes/new') >= 0) {
        if ($.trim($('#episode_medium_attributes_title').val()) != '') data.append('episode[medium_attributes][title]', $.trim($('#episode_medium_attributes_title').val()));
        if ($.trim($('#episode_medium_attributes_short_summary').val()) != '') data.append('episode[medium_attributes][short_summary]', $.trim($('#episode_medium_attributes_short_summary').val()));
        if ($.trim($('#episode_medium_attributes_episode_identifier').val()) != '') data.append('episode[medium_attributes][episode_identifier]', $.trim($('#episode_medium_attributes_episode_identifier').val()));
      }
    }
  
    function errorHandler(e) {
      var msg = '';
  
      switch (e.code) {
        case FileError.QUOTA_EXCEEDED_ERR:
          msg = 'Quota exceeded.';
          break;
        case FileError.NOT_FOUND_ERR:
          msg = 'File not found.';
          break;
        case FileError.SECURITY_ERR:
          msg = 'Security error.';
          break;
        case FileError.INVALID_MODIFICATION_ERR:
          msg = 'Invalid notification.';
          break;
        case FileError.INVALID_STATE_ERR:
          msg = 'Invalid state.';
          break;
        default:
          msg = 'Unknown.';
          break;
      };
  
      console.log('Error: ' + msg);
    }
  
    $.fn.dndUploader = function(method) {
      if (methods[method]) {
        return methods[method].apply(this, Array.prototype.slice.call(arguments, 1));
      } else if (typeof method === 'object' || ! method) {
        return methods.init.apply(this, arguments);
      } else {
        $.error('Method ' + method + ' does not exist on dndUploader object.');
      }
    };
  })(jQuery);
  