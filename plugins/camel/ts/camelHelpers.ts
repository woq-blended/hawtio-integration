/// <reference path="endpointChooser.ts"/>

declare var _apacheCamelModel:any;

namespace Camel {

  export const log: Logging.Logger = Logger.get("Camel");

  export const jmxDomain: string = 'org.apache.camel';

  export const defaultMaximumLabelWidth = 34;
  export const defaultCamelMaximumTraceOrDebugBodyLength = 5000;
  export const defaultCamelTraceOrDebugIncludeStreams = false;
  export const defaultCamelRouteMetricMaxSeconds = 10;
  export const defaultHideOptionDocumentation = false;
  export const defaultHideOptionDefaultValue = false;
  export const defaultHideOptionUnusedValue = false;

  export var _apacheCamelModel: any = undefined;

  hawtioPluginLoader.registerPreBootstrapTask((next) => {
    Camel._apacheCamelModel = window['_apacheCamelModel'];
    log.debug("Setting apache camel model: ", Camel._apacheCamelModel);
    next();
  });

  /**
   * Returns if the given CamelContext has any rest services
   *
   * @param workspace
   * @param jolokia
   * @returns {boolean}
   */
  export function hasRestServices(workspace: Jmx.Workspace, jolokia: Jolokia.IJolokia): boolean {
    const mbean = getSelectionCamelRestRegistry(workspace);
    if (mbean) {
      const numberOfRestServices = jolokia.getAttribute(mbean, 'NumberOfRestServices');
      return numberOfRestServices > 0;
    }
    return false;
  }

  /**
   * Looks up the route XML for the given context and selected route and
   * processes the selected route's XML with the given function
   * @method processRouteXml
   * @param {Workspace} workspace
   * @param {Object} jolokia
   * @param {Folder} folder
   * @param {Function} onRoute
   */
  export function processRouteXml(workspace: Jmx.Workspace, jolokia: Jolokia.IJolokia, folder: Jmx.Folder, onRoute: (route: Element) => void) {
    var selectedRouteId = getSelectedRouteId(workspace, folder);
    var mbean = getExpandingFolderCamelContextMBean(workspace, folder) || getSelectionCamelContextMBean(workspace);

    var onRouteXml = response => {
      var route = null;
      var data = response ? response.value : null;
      if (data) {
        var doc = $.parseXML(data);
        var routes = $(doc).find("route[id='" + selectedRouteId + "']");
        if (routes && routes.length) {
          route = routes[0];
        }
      }
      onRoute(route);
    }

    if (mbean && selectedRouteId) {
      jolokia.request(
              {type: 'exec', mbean: mbean, operation: 'dumpRoutesAsXml()'},
              Core.onSuccess(onRouteXml, {error: onRouteXml}));
    } else {
      if (!selectedRouteId) {
        log.warn("No selectedRouteId when trying to lazy load the route!")
      }
      onRoute(null);
    }
  }

  /**
   * Returns the URI string for the given EIP pattern node or null if it is not applicable
   * @method getRouteNodeUri
   * @param {Object} node
   * @return {String}
   */
  export function getRouteNodeUri(node) {
    var uri: string = null;
    if (node) {
      uri = node.getAttribute("uri");
      if (!uri) {
        var ref = node.getAttribute("ref");
        if (ref) {
          var method = node.getAttribute("method");
          if (method) {
            uri = ref + "." + method + "()";
          } else {
            uri = "ref:" + ref;
          }
        }
      }
    }
    return uri;
  }

  /**
   * Returns the JSON data for the camel folder; extracting it from the associated
   * routeXmlNode or using the previously extracted and/or edited JSON
   * @method getRouteFolderJSON
   * @param {Folder} folder
   * @param {Object} answer
   * @return {Object}
   */
  export function getRouteFolderJSON(folder, answer = {}) {
    var nodeData = folder["camelNodeData"];
    if (!nodeData) {
      var routeXmlNode = folder["routeXmlNode"];
      if (routeXmlNode) {
        nodeData = Camel.getRouteNodeJSON(routeXmlNode);
      }
      if (!nodeData) {
        nodeData = answer;
      }
      folder["camelNodeData"] = nodeData;
    }
    return nodeData;
  }

  export function getRouteNodeJSON(routeXmlNode, answer = {}) {
    if (routeXmlNode) {
      angular.forEach(routeXmlNode.attributes, (attr) => {
        answer[attr.name] = attr.value;
      });

      // lets not iterate into routes/rests or top level tags
      var localName = routeXmlNode.localName;
      if (localName !== "route" && localName !== "routes" && localName !== "camelContext" && localName !== "rests") {
        // lets look for nested elements and convert those
        // explicitly looking for expressions
        $(routeXmlNode).children("*").each((idx, element) => {
          var nodeName = element.localName;
          var langSettings = Camel.camelLanguageSettings(nodeName);
          if (langSettings) {
            // TODO the expression key could be anything really; how should we know?
            answer["expression"] = {
              language: nodeName,
              expression: element.textContent
            };
          } else {
            if (!isCamelPattern(nodeName)) {
              var nested = getRouteNodeJSON(element);
              if (nested) {
                // unwrap the nested expression which we do not want to double wrap
                if (nested["expression"]) {
                  nested = nested["expression"];
                }
                // special for aggregate as it has duplicate option names
                if (nodeName === "completionSize") {
                  nodeName = "completionSizeExpression";
                } else if (nodeName === "completionTimeout") {
                  nodeName = "completionTimeoutExpression";
                }
                answer[nodeName] = nested;
              }
            }
          }
        });
      }
    }
    return answer;
  }

  export function increaseIndent(currentIndent: string, indentAmount = "  ") {
    return currentIndent + indentAmount;
  }

  export function setRouteNodeJSON(routeXmlNode, newData, indent) {
    if (routeXmlNode) {
      var childIndent = increaseIndent(indent);

      function doUpdate(value, key, append = false) {
        if (angular.isArray(value)) {
          // remove previous nodes
          $(routeXmlNode).children(key).remove();
          angular.forEach(value, (item) => {
            doUpdate(item, key, true);
          });
        } else if (angular.isObject(value)) {
          // convert languages to the right xml
          var textContent = null;
          if (key === "expression") {
            var languageName = value["language"];
            if (languageName) {
              key = languageName;
              textContent = value["expression"];
              value = angular.copy(value);
              delete value["expression"];
              delete value["language"];
            }
          }
          // TODO deal with nested objects...
          var nested = $(routeXmlNode).children(key);
          var element = null;
          if (append || !nested || !nested.length) {
            var doc = routeXmlNode.ownerDocument || document;
            routeXmlNode.appendChild(doc.createTextNode("\n" + childIndent));
            element = doc.createElementNS(routeXmlNode.namespaceURI, key);
            if (textContent) {
              element.appendChild(doc.createTextNode(textContent));
            }
            routeXmlNode.appendChild(element);
          } else {
            element = nested[0];
          }
          setRouteNodeJSON(element, value, childIndent);
          if (textContent) {
            nested.text(textContent);
          }
        } else {
          if (value) {
            if (_.startsWith(key, "_")) {
              // ignore
            } else {
              var text = value.toString();
              routeXmlNode.setAttribute(key, text);
            }
          } else {
            routeXmlNode.removeAttribute(key);
          }
        }
      }

      angular.forEach(newData, (value, key) => doUpdate(value, key, false));
    }
  }

  export function getRouteNodeIcon(nodeSettingsOrXmlNode) {
    var nodeSettings = null;
    if (nodeSettingsOrXmlNode) {
      var nodeName = nodeSettingsOrXmlNode.localName;
      if (nodeName) {
        nodeSettings = getCamelSchema(nodeName);
      } else {
        nodeSettings = nodeSettingsOrXmlNode;
      }
    }
    if (nodeSettings) {
      var imageName = nodeSettings["icon"] || "generic24.png";
      return UrlHelpers.join("img/icons/camel/", imageName);
    } else {
      return null;
    }
  }

  /**
   * Parse out the currently selected endpoint's name to be used when invoking on a
   * context operation that wants an endpoint name
   * @method getSelectedEndpointName
   * @param {Workspace} workspace
   * @return {any} either a string that is the endpoint name or null if it couldn't be parsed
   */
  export function getSelectedEndpointName(workspace: Jmx.Workspace) {
    var selection = workspace.selection;
    if (selection && selection['objectName'] && selection['typeName'] && selection['typeName'] === 'endpoints') {
      var mbean = Core.parseMBean(selection['objectName']);
      if (!mbean) {
        return null;
      }
      var attributes = mbean['attributes'];
      if (!attributes) {
        return null;
      }

      if (!('name' in attributes)) {
        return null;
      }

      var uri = attributes['name'];
      uri = uri.replace("\\?", "?");
      if (_.startsWith(uri, "\"")) {
        uri = uri.substr(1);
      }
      if (_.endsWith(uri, "\"")) {
        uri = uri.substr(0, uri.length - 1);
      }
      return uri;
    } else {
      return null;
    }
  }

  /**
   * Escapes the given URI text so it can be used in a JMX name
   */
  export function escapeEndpointUriNameForJmx(uri) {
    if (angular.isString(uri)) {
      var answer = uri.replace("?", "\\?");
      // lets ensure that we have a "//" after each ":"
      answer = answer.replace(/\:(\/[^\/])/, "://$1");
      answer = answer.replace(/\:([^\/])/, "://$1");
      return answer;
    } else {
      return uri;
    }
  }

  /**
   * Returns the mbean for the currently selected camel context and the name of the currently
   * selected endpoint for JMX operations on a context that require an endpoint name.
   * @method
   * @param workspace
   * @return {{uri: string, mbean: string}} either value could be null if there's a parse failure
   */
  export function getContextAndTargetEndpoint(workspace: Jmx.Workspace) {
    return {
      uri: Camel.getSelectedEndpointName(workspace),
      mbean: Camel.getSelectionCamelContextMBean(workspace)
    };
  }

  /**
   * Returns the cached Camel XML route node stored in the current tree selection Folder
   * @method
   */
  export function getSelectedRouteNode(workspace: Jmx.Workspace) {
    var selection = workspace.selection || workspace.getSelectedMBean();
    return (selection && jmxDomain === selection.domain) ? selection["routeXmlNode"] : null;
  }

  /**
   * Returns true when the selected node is a Camel XML route node, false otherwise.
   * @method
   */
  export function isRouteNode(workspace: Jmx.Workspace) {
    var selection = workspace.selection || workspace.getSelectedMBean();
    return selection && jmxDomain === selection.domain && "routeXmlNode" in selection;
  }

  /**
   * Looks up the given node name in the Camel schema
   * @method
   */
  export function getCamelSchema(nodeIdOrDefinition) {
    return (angular.isObject(nodeIdOrDefinition)) ? nodeIdOrDefinition : Forms.lookupDefinition(nodeIdOrDefinition, _apacheCamelModel);
  }

  /**
   * Returns true if the given nodeId is a route, endpoint or pattern
   * (and not some nested type like a data format)
   * @method
   */
  export function isCamelPattern(nodeId) {
    return Forms.lookupDefinition(nodeId, _apacheCamelModel) != null;
  }

  /**
   * Looks up the Camel language settings for the given language name
   * @method
   */
  export function camelLanguageSettings(nodeName) {
    return Camel._apacheCamelModel.languages[nodeName];
  }

  export function isCamelLanguage(nodeName) {
    return (camelLanguageSettings(nodeName) || nodeName === "expression") ? true : false;
  }

  /**
   * Adds the route children to the given folder for each step in the route
   * @method
   */
  export function loadRouteChildren(folder: Jmx.Folder, route: Element): Jmx.NodeSelection[] {
    folder['routeXmlNode'] = route;
    route.setAttribute('_cid', folder.key);
    const children = [];
    $(route).children('*').each((idx, node) => {
      children.push(loadRouteChild(folder, node))
    });
    return _.compact(children);
  }

  /**
   * Adds a child to the given folder / route
   * @method
   */
  function loadRouteChild(parent: Jmx.Folder, route: Element): Jmx.NodeSelection | void {
    const nodeName = route.localName;
    var nodeSettings = getCamelSchema(nodeName);
    if (nodeSettings) {
      var imageUrl = getRouteNodeIcon(nodeSettings);

      var node = new Jmx.Folder(nodeName);
      node.domain = jmxDomain;
      node.typeName = 'routeNode';
      updateRouteNodeLabelAndTooltip(node, route, nodeSettings);

      // TODO should maybe auto-generate these?
      node.folderNames = parent.folderNames;
      var id = route.getAttribute('id') || nodeName;
      var key = parent.key + '_' + Core.toSafeDomID(id);

      // lets find the next key thats unique
      var counter = 1;
      var notFound = true;
      while (notFound) {
        var tmpKey = key + counter;
        if (_.find(parent.children, { key: tmpKey })) {
          counter += 1;
        } else {
          notFound = false;
          key = tmpKey;
        }
      }
      node.key = key;
      node.image = imageUrl;
      node['routeXmlNode'] = route;
      const children = loadRouteChildren(node, route);
      children.forEach(child => node.moveChild(child));
      return node;
    }
  }

  /**
   * Returns the root JMX Folder of the camel mbeans
   */
  export function getRootCamelFolder(workspace: Jmx.Workspace): Jmx.Folder {
    var tree = workspace ? workspace.tree : null;
    if (tree) {
      return tree.get(jmxDomain) as Jmx.Folder;
    }
    return null;
  }

  /**
   * Returns the JMX folder for the camel context
   */
  export function getCamelContextFolder(workspace: Jmx.Workspace, camelContextId: string): Jmx.Folder {
    var answer = null;
    var root = getRootCamelFolder(workspace);
    if (root && camelContextId) {
        return root.findDescendant(node => camelContextId === node.text) as Jmx.Folder;
    }
    return answer;
  }

  /**
   * Returns the mbean for the given camel context ID or null if it cannot be found
   */
  export function getCamelContextMBean(workspace: Jmx.Workspace, camelContextId): string | null {
    const contextsFolder = getCamelContextFolder(workspace, camelContextId);
    if (contextsFolder) {
      return contextsFolder.objectName;
    }
    return null;
  }

  export function getFolderCamelNodeId(folder) {
    var answer = Core.pathGet(folder, ["routeXmlNode", "localName"]);
    return ("from" === answer || "to" === answer) ? "endpoint" : answer;
  }

  /**
   * Rebuilds the DOM tree from the tree node and performs all the various hacks
   * to turn the folder / JSON / model into valid camel XML
   * such as renaming language elements from <language expression="foo" language="bar/>
   * to <bar>foo</bar>
   * and changing <endpoint> into either <from> or <to>
   * @method
   * @param treeNode is either the Node from the tree widget (with the real Folder in the data property) or a Folder
   */
  export function createFolderXmlTree(treeNode, xmlNode, indent = Camel.increaseIndent("")) {
    var folder = treeNode.data || treeNode;
    var count = 0;
    var parentName = getFolderCamelNodeId(folder);
    if (folder) {
      if (!xmlNode) {
        xmlNode = document.createElement(parentName);
        var rootJson = Camel.getRouteFolderJSON(folder);
        if (rootJson) {
          Camel.setRouteNodeJSON(xmlNode, rootJson, indent);
        }
      }
      var doc = xmlNode.ownerDocument || document;
      var namespaceURI = xmlNode.namespaceURI;

      var from = parentName !== "route";
      var childIndent = Camel.increaseIndent(indent);
      angular.forEach(treeNode.children || treeNode.getChildren(), (childTreeNode) => {
        var childFolder = childTreeNode.data || childTreeNode;
        var name = Camel.getFolderCamelNodeId(childFolder);
        var json = Camel.getRouteFolderJSON(childFolder);
        if (name && json) {
          var language = false;
          if (name === "endpoint") {
            if (from) {
              name = "to";
            } else {
              name = "from";
              from = true;
            }
          }
          if (name === "expression") {
            var languageName = json["language"];
            if (languageName) {
              name = languageName;
              language = true;
            }
          }

          // lets create the XML
          xmlNode.appendChild(doc.createTextNode("\n" + childIndent));
          var newNode = doc.createElementNS(namespaceURI, name);

          Camel.setRouteNodeJSON(newNode, json, childIndent);
          xmlNode.appendChild(newNode);
          count += 1;
          createFolderXmlTree(childTreeNode, newNode, childIndent);
        }
      });
      if (count) {
        xmlNode.appendChild(doc.createTextNode("\n" + indent));
      }
    }
    return xmlNode;
  }

  export function updateRouteNodeLabelAndTooltip(folder: Jmx.Folder, routeXmlNode, nodeSettings) {
    var localName = routeXmlNode.localName;
    var id = routeXmlNode.getAttribute("id");
    var label = nodeSettings["title"] || localName;

    // lets use the ID for routes and other things we give an id
    var tooltip = nodeSettings["tooltip"] || nodeSettings["description"] || label;
    if (id) {
      label = id;
    } else {
      var uri = getRouteNodeUri(routeXmlNode);
      if (uri) {
        // Don't use from/to as it gets odd if you drag/drop and reorder
        // label += " " + uri;
        label = uri;
        var split = uri.split("?");
        if (split && split.length > 1) {
          label = split[0];
        }
        tooltip += " " + uri;
      } else {
        var children = $(routeXmlNode).children("*");
        if (children && children.length) {
          var child = children[0];
          var childName = child.localName;
          var expression = null;
          if (Camel.isCamelLanguage(childName)) {
            expression = child.textContent;
            if (!expression) {
              expression = child.getAttribute("expression");
            }
          }
          if (expression) {
            label += " " + expression;
            tooltip += " " + childName + " expression";
          }
        }
      }
    }
    folder.text = label;
    folder.tooltip = tooltip;
    return label;
  }

  /**
   * Returns the selected camel context object name for the given selection or null if it cannot be found
   * @method
   */
  export function getSelectionCamelContextMBean(workspace: Jmx.Workspace): string {
    const context = getSelectionCamelContext(workspace);
    if (context) {
      return context.objectName;
    }
    return null;
  }

  /**
   * Returns the selected camel context object name for the given selection or null if it cannot be found
   * @method
   */
  export function getSelectionCamelContext(workspace: Jmx.Workspace): Jmx.NodeSelection {
    if (workspace) {
      const contextId = getContextId(workspace);
      const selection = workspace.selection;
      const tree = workspace.tree;
      if (tree && selection) {
        const domain = selection.domain;
        if (domain && contextId) {
          return tree.findDescendant(node => node.typeName === 'context'
            && node.domain === domain
            && node.text === contextId);
        }
      }
    }
    return null;
  }

  /**
   * When lazy loading route info (using dumpRoutesAsXml() operation) we need MBean name from the folder
   * and *not* from the selection
   * @param {Workspace} workspace
   * @param {Folder} folder
   */
  export function getExpandingFolderCamelContextMBean(workspace: Jmx.Workspace, folder: Jmx.Folder): string {
    if (folder.entries && folder.entries['type'] === 'routes') {
      const context = workspace.tree.findDescendant(node => node.typeName === 'context'
        && node.domain === 'org.apache.camel'
        && node.text === folder.entries['context']);
      if (context) {
        return context.objectName;
      }
    }
    return null;
  }

  export function getSelectionCamelContextEndpoints(workspace: Jmx.Workspace): Jmx.NodeSelection {
    if (workspace) {
      var contextId = getContextId(workspace);
      var selection = workspace.selection;
      var tree = workspace.tree;
      if (tree && selection) {
        var domain = selection.domain;
        if (domain && contextId) {
          return tree.navigate(domain, 'Camel Contexts', contextId, 'endpoints');
        }
      }
    }
    return null;
  }

  /**
   * Returns the selected camel trace mbean for the given selection or null if it cannot be found
   * @method
   */
    // TODO Should be a service
  export function getSelectionCamelTraceMBean(workspace: Jmx.Workspace): string {
    if (workspace) {
      var contextId = getContextId(workspace);
      var selection = workspace.selection;
      var tree = workspace.tree;
      if (tree && selection) {
        var domain = selection.domain;
        if (domain && contextId) {
          // look for the Camel 2.11 mbean which we prefer
          var result = tree.navigate(domain, 'Camel Contexts', contextId, 'MBeans', 'tracer');
          if (result && result.children) {
            var mbean = _.find(result.children, m => _.startsWith(m.text, 'BacklogTracer'));
            if (mbean) {
              return mbean.objectName;
            }
          }
        }
      }
    }
    return null;
  }

  export function getSelectionCamelDebugMBean(workspace: Jmx.Workspace): string {
    if (workspace) {
      var contextId = getContextId(workspace);
      var selection = workspace.selection;
      var tree = workspace.tree;
      if (tree && selection) {
        var domain = selection.domain;
        if (domain && contextId) {
          var result = tree.navigate(domain, 'Camel Contexts', contextId, 'MBeans', 'tracer');
          if (result && result.children) {
            var mbean = _.find(result.children, m => _.startsWith(m.text, 'BacklogDebugger'));
            if (mbean) {
              return mbean.objectName;
            }
          }
        }
      }
    }
    return null;
  }

  export function getSelectionCamelTypeConverter(workspace: Jmx.Workspace): string {
    if (workspace) {
      var contextId = getContextId(workspace);
      var selection = workspace.selection;
      var tree = workspace.tree;
      if (tree && selection) {
        var domain = selection.domain;
        if (domain && contextId) {
          var result = tree.navigate(domain, 'Camel Contexts', contextId, 'MBeans', 'services');
          if (result && result.children) {
            var mbean = _.find(result.children, m => _.startsWith(m.text, 'DefaultTypeConverter'));
            if (mbean) {
              return mbean.objectName;
            }
          }
        }
      }
    }
    return null;
  }

  export function getSelectionCamelRestRegistry(workspace: Jmx.Workspace): string {
    if (workspace) {
      var contextId = getContextId(workspace);
      var selection = workspace.selection;
      var tree = workspace.tree;
      if (tree && selection) {
        var domain = selection.domain;
        if (domain && contextId) {
          var result = tree.navigate(domain, 'Camel Contexts', contextId, 'MBeans', 'services');
          if (result && result.children) {
            var mbean = _.find(result.children, m => _.startsWith(m.text, 'DefaultRestRegistry'));
            if (mbean) {
              return mbean.objectName;
            }
          }
        }
      }
    }
    return null;
  }

  export function getSelectionCamelEndpointRuntimeRegistry(workspace: Jmx.Workspace) : string {
    if (workspace) {
      var contextId = getContextId(workspace);
      var selection = workspace.selection;
      var tree = workspace.tree;
      if (tree && selection) {
        var domain = selection.domain;
        if (domain && contextId) {
          var result = tree.navigate(domain, 'Camel Contexts', contextId, 'MBeans', 'services');
          if (result && result.children) {
            var mbean = _.find(result.children, m => _.startsWith(m.text, 'DefaultRuntimeEndpointRegistry'));
            if (mbean) {
              return mbean.objectName;
            }
          }
        }
      }
    }
    return null;
  }

  export function getSelectionCamelInflightRepository(workspace: Jmx.Workspace): string {
    if (workspace) {
      var contextId = getContextId(workspace);
      var selection = workspace.selection;
      var tree = workspace.tree;
      if (tree && selection) {
        var domain = selection.domain;
        if (domain && contextId) {
          var result = tree.navigate(domain, 'Camel Contexts', contextId, 'MBeans', 'services');
          if (result && result.children) {
            var mbean = _.find(result.children, m => _.startsWith(m.text, 'DefaultInflightRepository'));
            if (mbean) {
              return mbean.objectName;
            }
          }
        }
      }
    }
    return null;
  }

  export function getSelectionCamelBlockedExchanges(workspace: Jmx.Workspace): string {
    if (workspace) {
      var contextId = getContextId(workspace);
      var selection = workspace.selection;
      var tree = workspace.tree;
      if (tree && selection) {
        var domain = selection.domain;
        if (domain && contextId) {
          var result = tree.navigate(domain, 'Camel Contexts', contextId, 'MBeans', 'services');
          if (result && result.children) {
            var mbean = _.find(result.children, m => _.startsWith(m.text, 'DefaultAsyncProcessorAwaitManager'));
            if (mbean) {
              return mbean.objectName;
            }
          }
        }
      }
    }
    return null;
  }

  export function getSelectionCamelRouteMetrics(workspace: Jmx.Workspace): string {
    if (workspace) {
      var contextId = getContextId(workspace);
      var selection = workspace.selection;
      var tree = workspace.tree;
      if (tree && selection) {
        var domain = selection.domain;
        if (domain && contextId) {
          var result = tree.navigate(domain, 'Camel Contexts', contextId, 'MBeans', 'services');
          if (result && result.children) {
            var mbean = _.find(result.children, m => _.startsWith(m.text, 'MetricsRegistryService'));
            if (mbean) {
              return mbean.objectName;
            }
          }
        }
      }
    }
    return null;
  }

  // TODO should be a service
  export function getContextId(workspace: Jmx.Workspace) {
    const selection = workspace.selection;
    if (selection) {
      const context = selection.findAncestor(ancestor => ancestor.typeName === 'context');
      if (context) {
        return context.text;
      }
    }
  }

  export function iconClass(state:string) {
    if (state) {
      switch (state.toLowerCase()) {
        case 'started':
          return "green fa fa-play-circle";
        case 'suspended':
          return "fa fa-pause";
      }
    }
    return "orange fa fa-off";
  }

  export function getSelectedRouteId(workspace: Jmx.Workspace, folder?: Jmx.NodeSelection) {
    var selection = folder || workspace.selection;
    var selectedRouteId = null;
    if (selection) {
      if (selection && selection.entries) {
        var typeName = selection.entries["type"];
        var name = selection.entries["name"];
        if ("routes" === typeName && name) {
          selectedRouteId = Core.trimQuotes(name);
        }
      }
    }
    return selectedRouteId;
  }

  /**
   * Returns the selected camel route mbean for the given route id
   * @method
   */
    // TODO Should be a service
  export function getSelectionRouteMBean(workspace: Jmx.Workspace, routeId: String) : string {
    if (workspace) {
      var contextId = getContextId(workspace);
      var selection = workspace.selection;
      var tree = workspace.tree;
      if (tree && selection) {
        var domain = selection.domain;
        if (domain && contextId) {
          var result = tree.navigate(domain, 'Camel Contexts', contextId, 'routes');
          if (result && result.children) {
            var mbean = _.find(result.children, m => m.text === routeId);
            if (mbean) {
              return mbean.objectName;
            }
          }
        }
      }
    }
    return null;
  }

  export function getCamelVersion(workspace: Jmx.Workspace, jolokia) {
    const context = getSelectionCamelContext(workspace);
    if (context) {
      // must use onSuccess(null) that means sync as we need the version asap
      const version = jolokia.getAttribute(context.objectName, 'CamelVersion', Core.onSuccess(null));
      // cache version so we do not need to read it again using jolokia
      context.version = version;
      return version;
    }
    return null;
  }

  export function createMessageFromXml(exchange) {
    var exchangeElement = $(exchange);
    var uid = exchangeElement.children("uid").text();
    var timestamp = exchangeElement.children("timestamp").text();
    var messageData = {
      headers: {},
      headerTypes: {},
      id: null,
      uid: uid,
      timestamp: timestamp,
      headerHtml: ""
    };
    var message = exchangeElement.children("message")[0];
    if (!message) {
      message = exchange;
    }
    var messageElement = $(message);
    var headers = messageElement.find("header");
    var headerHtml = "";
    headers.each((idx, header) => {
      var key = header.getAttribute("key");
      var typeName = header.getAttribute("type");
      var value = header.textContent;
      if (key) {
        if (value) messageData.headers[key] = value;
        if (typeName) messageData.headerTypes[key] = typeName;

        headerHtml += "<tr><td class='property-name'>" + key + "</td>" +
                "<td class='property-value'>" + (humanizeJavaType(typeName)) + "</td>" +
                "<td class='property-value'>" + (value || "") + "</td></tr>";
      }
    });

    messageData.headerHtml = headerHtml;
    var id = messageData.headers["breadcrumbId"];
    if (!id) {
      var postFixes = ["MessageID", "ID", "Path", "Name"];
      angular.forEach(postFixes, (postfix) => {
        if (!id) {
          angular.forEach(messageData.headers, (value, key) => {
            if (!id && _.endsWith(key, postfix)) {
              id = value;
            }
          });
        }
      });

      // lets find the first header with a name or Path in it
      // if still no value, lets use the first :)
      angular.forEach(messageData.headers, (value, key) => {
        if (!id) id = value;
      });
    }
    messageData.id = id;
    var body = messageElement.children("body")[0];
    if (body) {
      var bodyText = body.textContent;
      var bodyType = body.getAttribute("type");
      messageData["body"] = bodyText;
      messageData["bodyType"] = humanizeJavaType(bodyType);
    }
    return messageData;
  }

  export function humanizeJavaType(type:string) {
    if (!type) {
      return "";
    }
    // skip leading java.lang
    if (_.startsWith(type, "java.lang")) {
      return type.substr(10)
    }
    return type;
  }

  export function createBrowseGridOptions() {
    return {
       selectedItems: [],
       data: 'messages',
       displayFooter: false,
       showFilter: false,
       showColumnMenu: true,
       enableColumnResize: true,
       enableColumnReordering: true,
       filterOptions: {
         filterText: ''
       },
       selectWithCheckboxOnly: true,
       showSelectionCheckbox: true,
       maintainColumnRatios: false,
       columnDefs: [
         {
           field: 'id',
           displayName: 'ID',
           // for ng-grid
           //width: '50%',
           // for hawtio-datatable
           // width: "22em",
           cellTemplate: '<div class="ngCellText"><a href="" ng-click="row.entity.openMessageDialog(row)">{{row.entity.id}}</a></div>'
         }
       ]
     };
  }

  export function loadRouteXmlNodes($scope, doc, selectedRouteId, nodes, links, width) {
    var allRoutes = $(doc).find("route");
    var routeDelta = width / allRoutes.length;
    var rowX = 0;
    allRoutes.each((idx, route) => {
      var routeId = route.getAttribute("id");
      if (!selectedRouteId || !routeId || selectedRouteId === routeId) {
        Camel.addRouteXmlChildren($scope, route, nodes, links, null, rowX, 0);
        rowX += routeDelta;
      }
    });
  }

  export function addRouteXmlChildren($scope, parent, nodes, links, parentId, parentX, parentY, parentNode = null) {
    var delta = 150;
    var x = parentX;
    var y = parentY + delta;
    var rid = parent.getAttribute("id");
    var siblingNodes = [];
    var parenNodeName = parent.localName;
    $(parent).children().each((idx, route) => {
      var id = nodes.length;
      // from acts as a parent even though its a previous sibling :)
      var nodeId = route.localName;
      if (nodeId === "from" && !parentId) {
        parentId = id;
      }
      var nodeSettings = getCamelSchema(nodeId);
      var node = null;
      if (nodeSettings) {
        var label = nodeSettings["title"] || nodeId;
        var uri = getRouteNodeUri(route);
        if (uri) {
          label += " " + uri.split("?")[0];
        }
        var tooltip = nodeSettings["tooltip"] || nodeSettings["description"] || label;
        if (uri) {
          tooltip += " " + uri;
        }
        var elementID = route.getAttribute("id");
        var labelSummary = label;
        if (elementID) {
          var customId = route.getAttribute("customId");
          if ($scope.camelIgnoreIdForLabel || (!customId || customId === "false")) {
            labelSummary = "id: " + elementID;
          } else {
            label = elementID;
          }
        }
        // lets check if we need to trim the label
        var labelLimit = $scope.camelMaximumLabelWidth || Camel.defaultMaximumLabelWidth;
        var length = label.length;
        if (length > labelLimit) {
          labelSummary = label + "\n\n" + labelSummary;
          label = label.substring(0, labelLimit) + "..";
        }

        var imageUrl = getRouteNodeIcon(nodeSettings);
        if ((nodeId === "from" || nodeId === "to") && uri) {
          var uriIdx = uri.indexOf(":");
          if (uriIdx > 0) {
            var componentScheme = uri.substring(0, uriIdx);
            //console.log("lets find the endpoint icon for " + componentScheme);
            if (componentScheme) {
              var value = Camel.getEndpointIcon(componentScheme);
              if (value) {
                imageUrl = Core.url(value);
              }
            }
          }
        }

        //console.log("Image URL is " + imageUrl);
        var cid = route.getAttribute("_cid") || route.getAttribute("id");
        node = { "name": name, "label": label, "labelSummary": labelSummary, "group": 1, "id": id, "elementId": elementID,
          "x": x, "y:": y, "imageUrl": imageUrl, "cid": cid, "tooltip": tooltip, "type": nodeId, "uri": uri};
        if (rid) {
          node["rid"] = rid;
          if (!$scope.routeNodes) $scope.routeNodes = {};
          $scope.routeNodes[rid] = node;
        }
        if (!cid) {
          cid = nodeId + (nodes.length + 1);
        }
        if (cid) {
          node["cid"] = cid;
          if (!$scope.nodes) $scope.nodes = {};
          $scope.nodes[cid] = node;
        }
        // only use the route id on the first from node
        rid = null;
        nodes.push(node);
        if (parentId !== null && parentId !== id) {
          if (siblingNodes.length === 0 || parenNodeName === "choice") {
            links.push({"source": parentId, "target": id, "value": 1});
          } else {
            siblingNodes.forEach(function (nodeId) {
              links.push({"source": nodeId, "target": id, "value": 1});
            });
            siblingNodes.length = 0;
          }
        }
      } else {
        // ignore non EIP nodes, though we should add expressions...
        var langSettings =  Camel.camelLanguageSettings(nodeId);
        if (langSettings && parentNode) {
          // lets add the language kind
          var name = langSettings["name"] || nodeId;
          var text = route.textContent;
          if (text) {
            parentNode["tooltip"] = parentNode["label"] + " " + name + " " + text;
            parentNode["label"] += ": " + appendLabel(route, text, true);
          } else {
            parentNode["label"] += ": " + appendLabel(route, name, false);
          }
        }
      }
      var siblings = addRouteXmlChildren($scope, route, nodes, links, id, x, y, node);
      if (parenNodeName === "choice") {
        siblingNodes = siblingNodes.concat(siblings);
        x += delta;
      } else if (nodeId === "choice") {
        siblingNodes = siblings;
        y += delta;
      } else {
        siblingNodes = [nodes.length - 1];
        y += delta;
      }
    });
    return siblingNodes;
  }

  function appendLabel(route: Element, label: string, text: boolean): string {
    switch (route.localName) {
      case "method":
        if (!text) {
          if (route.getAttribute("bean")) {
            label += " " + route.getAttribute("bean");
          } else if (route.getAttribute("ref")) {
            label += " " + route.getAttribute("ref");
          } else if (route.getAttribute("beanType")) {
            label += " " + route.getAttribute("beanType");
          }
        }
        if (route.getAttribute("method")) {
          label += " " + route.getAttribute("method");
        }
        break;
      default:
    }
    return label;
  }

  /**
   * Returns an object of all the CamelContext MBeans keyed by their id
   * @method
   */
  export function camelContextMBeansById(workspace: Jmx.Workspace): { [id: string]: Jmx.Folder } {
    const answer = {};
    const tree = workspace.tree;
    if (tree) {
      const contexts = tree.navigate(Camel.jmxDomain, 'Camel Contexts');
      if (contexts) {
        angular.forEach(contexts.children, (context: Jmx.Folder) => {
          const id = Core.pathGet(context, ['entries', 'name']) || context.key;
          if (id) {
            answer[id] = context;
          }
        });
      }
    }
    return answer;
  }

  /**
   * Returns an object of all the CamelContext MBeans keyed by the component name
   * @method
   */
  export function camelContextMBeansByComponentName(workspace: Jmx.Workspace) {
    return camelContextMBeansByRouteOrComponentId(workspace, 'components')
  }

  /**
   * Returns an object of all the CamelContext MBeans keyed by the route ID
   * @method
   */
  export function camelContextMBeansByRouteId(workspace: Jmx.Workspace) {
    return camelContextMBeansByRouteOrComponentId(workspace, 'routes')
  }

  function camelContextMBeansByRouteOrComponentId(workspace: Jmx.Workspace, componentsOrRoutes: string) {
    const answer = {};
    const tree = workspace.tree;
    if (tree) {
      const contexts = tree.navigate(Camel.jmxDomain, 'Camel Contexts');
      if (contexts) {
        angular.forEach(contexts.children, (context: Jmx.Folder) => {
          const components = context.navigate(componentsOrRoutes);
          if (context && components && context.children && context.children.length) {
            const mbean = context.objectName;
            if (mbean) {
              const contextValues = {
                folder: context,
                mbean: mbean
              };
              angular.forEach(components.children, componentFolder => {
                const id = componentFolder.text;
                if (id) {
                  answer[id] = contextValues;
                }
              });
            }
          }
        });
      }
    }
    return answer;
  }

  /**
   * Returns true if we should ignore ID values for labels in camel diagrams
   * @method
   */
  export function ignoreIdForLabel(localStorage) {
    var value = localStorage["camelIgnoreIdForLabel"];
    return Core.parseBooleanValue(value);
  }

  /**
   * Returns the maximum width of a label before we start to truncate
   * @method
   */
  export function maximumLabelWidth(localStorage) {
    var value = localStorage["camelMaximumLabelWidth"];
    if (angular.isString(value)) {
      value = parseInt(value);
    }
    if (!value) {
      value = Camel.defaultMaximumLabelWidth;
    }
    return value;
  }

  /**
   * Returns the max body length for tracer and debugger
   * @method
   */
  export function maximumTraceOrDebugBodyLength(localStorage) {
    var value = localStorage["camelMaximumTraceOrDebugBodyLength"];
    if (angular.isString(value)) {
      value = parseInt(value);
    }
    if (!value) {
      value = Camel.defaultCamelMaximumTraceOrDebugBodyLength;
    }
    return value;
  }

  /**
   * Returns whether to include streams body for tracer and debugger
   * @method
   */
  export function traceOrDebugIncludeStreams(localStorage) {
    var value = localStorage["camelTraceOrDebugIncludeStreams"];
    return Core.parseBooleanValue(value, Camel.defaultCamelTraceOrDebugIncludeStreams);
  }

  /**
   * Returns true if we should show inflight counter in Camel route diagram
   * @method
   */
  export function showInflightCounter(localStorage) {
    var value = localStorage["camelShowInflightCounter"];
    // is default enabled
    return Core.parseBooleanValue(value, true);
  }

  /**
   * Returns the max value for seconds in the route metrics UI
   * @method
   */
  export function routeMetricMaxSeconds(localStorage) {
    var value = localStorage["camelRouteMetricMaxSeconds"];
    if (angular.isString(value)) {
      value = parseInt(value);
    }
    if (!value) {
      value = Camel.defaultCamelRouteMetricMaxSeconds;
    }
    return value;
  }

  /**
   * Whether to hide the documentation for the options
   * @method
   */
  export function hideOptionDocumentation(localStorage) {
    var value = localStorage["camelHideOptionDocumentation"];
    return Core.parseBooleanValue(value, Camel.defaultHideOptionDocumentation);
  }

  /**
   * Whether to hide options which uses default values
   * @method
   */
  export function hideOptionDefaultValue(localStorage) {
    var value = localStorage["camelHideOptionDefaultValue"];
    return Core.parseBooleanValue(value, Camel.defaultHideOptionDefaultValue);
  }

  /**
   * Whether to hide options which have unused/empty values
   * @method
   */
  export function hideOptionUnusedValue(localStorage) {
    var value = localStorage["camelHideOptionUnusedValue"];
    return Core.parseBooleanValue(value, Camel.defaultHideOptionUnusedValue);
  }

  /**
   * Function to highlight the selected toNode in the nodes graph
   *
   * @param nodes the nodes
   * @param toNode the node to highlight
   */
  export function highlightSelectedNode(nodes, toNode) {
    // lets clear the selected node first
    nodes.classed("selected", false);

    nodes.filter(function (item) {
      if (item) {
        var cid = item["cid"];
        var rid = item["rid"];
        var type = item["type"];
        var elementId = item["elementId"];

        // if its from then match on rid
        if ("from" === type) {
          return toNode === rid;
        }

        // okay favor using element id as the cids can become
        // undefined or mangled with mbean object names, causing this to not work
        // where as elementId when present works fine
        if (elementId) {
          // we should match elementId if defined
          return toNode === elementId;
        }
        // then fallback to cid
        if (cid) {
          return toNode === cid;
        } else {
          // and last rid
          return toNode === rid;
        }
      }
      return null;
    }).classed("selected", true);
  }

  /**
   * Is the currently selected Camel version equal or greater than
   *
   * @param major   major version as number
   * @param minor   minor version as number
   */
  export function isCamelVersionEQGT(major, minor, workspace, jolokia) {
    var camelVersion = getCamelVersion(workspace, jolokia);
    if (camelVersion) {
      // console.log("Camel version " + camelVersion)
      camelVersion += "camel-";
      var numbers = Core.parseVersionNumbers(camelVersion);
      if (Core.compareVersionNumberArrays(numbers, [major, minor]) >= 0) {
        return true;
      } else {
        return false;
      }
    }
    return false;
  }

}
