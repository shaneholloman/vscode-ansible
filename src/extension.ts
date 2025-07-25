/* "stdlib" */
import * as vscode from "vscode";
import * as path from "path";
import { ExtensionContext, extensions, window, workspace } from "vscode";
import { Vault } from "./features/vault";
import { AnsibleCommands } from "./definitions/constants";
import { LightSpeedCommands, UserAction } from "./definitions/lightspeed";
import {
  TelemetryErrorHandler,
  TelemetryOutputChannel,
  TelemetryManager,
} from "./utils/telemetryUtils";

/* third-party */
import {
  LanguageClient,
  LanguageClientOptions,
  NotificationType,
  ServerOptions,
  TransportKind,
  RevealOutputChannelOn,
} from "vscode-languageclient/node";

/* local */
import { SettingsManager } from "./settings";
import { AnsiblePlaybookRunProvider } from "./features/runner";
import {
  getConflictingExtensions,
  showUninstallConflictsNotification,
} from "./extensionConflicts";
import { languageAssociation } from "./features/fileAssociation";
import { MetadataManager } from "./features/ansibleMetaData";
import { updateConfigurationChanges } from "./utils/settings";
import { registerCommandWithTelemetry } from "./utils/registerCommands";
import {
  isDocumentInRole,
  isPlaybook,
} from "./features/lightspeed/utils/explanationUtils";
import { LightSpeedManager } from "./features/lightspeed/base";
import {
  ignorePendingSuggestion,
  inlineSuggestionCommitHandler,
  inlineSuggestionReplaceMarker,
  inlineSuggestionHideHandler,
  inlineSuggestionTextDocumentChangeHandler,
  inlineSuggestionTriggerHandler,
  LightSpeedInlineSuggestionProvider,
  rejectPendingSuggestion,
  setDocumentChanged,
} from "./features/lightspeed/inlineSuggestions";
import { ContentMatchesWebview } from "./features/lightspeed/contentMatchesWebview";
import {
  setPythonInterpreter,
  setPythonInterpreterWithCommand,
} from "./features/utils/setPythonInterpreter";
import { PythonInterpreterManager } from "./features/pythonMetadata";
import { AnsibleToxController } from "./features/ansibleTox/controller";
import { AnsibleToxProvider } from "./features/ansibleTox/provider";
import { findProjectDir } from "./features/ansibleTox/utils";
import { QuickLinksWebviewViewProvider } from "./features/quickLinks/utils/quickLinksViewProvider";
import { LightspeedFeedbackWebviewViewProvider } from "./features/lightspeed/feedbackWebviewViewProvider";
import { LightspeedFeedbackWebviewProvider } from "./features/lightspeed/feedbackWebviewProvider";
import { AnsibleWelcomePage } from "./features/welcomePage";
import { withInterpreter } from "./features/utils/commandRunner";
import { IFileSystemWatchers } from "./interfaces/watchers";
import { ExecException, execSync } from "child_process";
// import { LightspeedExplorerWebviewViewProvider } from "./features/lightspeed/explorerWebviewViewProvider";
import {
  LightspeedUser,
  AuthProviderType,
} from "./features/lightspeed/lightspeedUser";
import {
  PlaybookFeedbackEvent,
  RoleFeedbackEvent,
} from "./interfaces/lightspeed";
import { CreateDevfile } from "./features/contentCreator/createDevfilePage";
import { CreateExecutionEnv } from "./features/contentCreator/createExecutionEnvPage";
import { CreateDevcontainer } from "./features/contentCreator/createDevcontainerPage";
import { rightClickEEBuildCommand } from "./features/utils/buildExecutionEnvironment";
import { MainPanel as RoleGenerationPanel } from "./features/lightspeed/vue/views/roleGenPanel";
import { MainPanel as PlaybookGenerationPanel } from "./features/lightspeed/vue/views/playbookGenPanel";
import { MainPanel as ExplanationPanel } from "./features/lightspeed/vue/views/explanationPanel";
import { MainPanel as HelloWorldPanel } from "./features/lightspeed/vue/views/helloWorld";
import { MainPanel as createAnsibleCollectionPanel } from "./features/contentCreator/vue/views/createAnsibleCollectionPanel";
import { MainPanel as createAnsibleProjectPanel } from "./features/contentCreator/vue/views/createAnsibleProjectPanel";
import { MainPanel as addPatternPanel } from "./features/contentCreator/vue/views/addPatternPagePanel";
import { MainPanel as addPluginPanel } from "./features/contentCreator/vue/views/addPluginPagePanel";
import { MainPanel as createRolePanel } from "./features/contentCreator/vue/views/createRolePanel";
import { getRoleNameFromFilePath } from "./features/lightspeed/utils/getRoleNameFromFilePath";
import { getRoleNamePathFromFilePath } from "./features/lightspeed/utils/getRoleNamePathFromFilePath";
import { getRoleYamlFiles } from "./features/lightspeed/utils/data";

export let client: LanguageClient;
export let lightSpeedManager: LightSpeedManager;
export const globalFileSystemWatcher: IFileSystemWatchers = {};

const lsName = "Ansible Support";
let lsOutputChannel: vscode.OutputChannel;

export async function activate(context: ExtensionContext): Promise<void> {
  // dynamically associate "ansible" language to the yaml file
  await languageAssociation(context);

  // set correct python interpreter
  const workspaceFolders = workspace.workspaceFolders;
  if (workspaceFolders) {
    await setPythonInterpreter();
  }

  // Create Telemetry Service
  const telemetry = new TelemetryManager(context);
  await telemetry.initTelemetryService();

  // Initialize settings
  const extSettings = new SettingsManager();
  await extSettings.initialize();

  // Vault encrypt/decrypt handler
  const vault = new Vault(extSettings);

  await registerCommandWithTelemetry(
    context,
    telemetry,
    AnsibleCommands.ANSIBLE_VAULT,
    vault.toggleEncrypt.bind(vault),
    true,
  );

  await registerCommandWithTelemetry(
    context,
    telemetry,
    AnsibleCommands.ANSIBLE_INVENTORY_RESYNC,
    resyncAnsibleInventory,
    true,
  );

  await registerCommandWithTelemetry(
    context,
    telemetry,
    AnsibleCommands.ANSIBLE_PYTHON_SET_INTERPRETER,
    setPythonInterpreterWithCommand,
    true,
  );

  await registerCommandWithTelemetry(
    context,
    telemetry,
    LightSpeedCommands.LIGHTSPEED_AUTH_REQUEST,
    lightspeedLogin,
    true,
  );

  // start the client and the server
  await startClient(context, telemetry);

  notifyAboutConflicts();

  new AnsiblePlaybookRunProvider(context, extSettings, telemetry);

  // handle metadata status bar
  const metaData = new MetadataManager(context, client, telemetry, extSettings);
  await metaData.updateAnsibleInfoInStatusbar();

  // handle python status bar
  const pythonInterpreterManager = new PythonInterpreterManager(
    context,
    telemetry,
    extSettings,
  );
  try {
    await pythonInterpreterManager.updatePythonInfoInStatusbar();
  } catch (error) {
    console.error(`Error updating python status bar: ${error}`);
  }

  /**
   * Handle "Ansible Lightspeed" in the extension
   */
  lightSpeedManager = new LightSpeedManager(context, extSettings, telemetry);

  vscode.commands.executeCommand("setContext", "lightspeedConnectReady", true);

  const eeBuilderCommand = rightClickEEBuildCommand(
    "extension.buildExecutionEnvironment",
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      LightSpeedCommands.LIGHTSPEED_STATUS_BAR_CLICK,
      () =>
        lightSpeedManager.statusBarProvider.lightSpeedStatusBarClickHandler(),
    ),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ContentMatchesWebview.viewType,
      lightSpeedManager.contentMatchesProvider,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      LightSpeedCommands.LIGHTSPEED_FETCH_TRAINING_MATCHES,
      () => {
        lightSpeedManager.contentMatchesProvider.showContentMatches();
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      LightSpeedCommands.LIGHTSPEED_CLEAR_TRAINING_MATCHES,
      () => {
        lightSpeedManager.contentMatchesProvider.clearContentMatches();
      },
    ),
  );

  const lightSpeedSuggestionProvider = new LightSpeedInlineSuggestionProvider();
  ["file", "untitled"].forEach((scheme) => {
    context.subscriptions.push(
      vscode.languages.registerInlineCompletionItemProvider(
        { scheme, language: "ansible" },
        lightSpeedSuggestionProvider,
      ),
    );
  });

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      LightSpeedCommands.LIGHTSPEED_SUGGESTION_COMMIT,
      inlineSuggestionCommitHandler,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      LightSpeedCommands.LIGHTSPEED_SUGGESTION_HIDE,
      async (
        textEditor: vscode.TextEditor,
        edit: vscode.TextEditorEdit,
        userAction?: UserAction,
      ) => {
        await inlineSuggestionHideHandler(userAction);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      LightSpeedCommands.LIGHTSPEED_SUGGESTION_TRIGGER,
      inlineSuggestionTriggerHandler,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      LightSpeedCommands.LIGHTSPEED_SUGGESTION_MARKER,
      (
        textEditor: vscode.TextEditor,
        edit: vscode.TextEditorEdit,
        position: vscode.Position,
      ) => inlineSuggestionReplaceMarker(position),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      LightSpeedCommands.LIGHTSPEED_PLAYBOOK_EXPLANATION,
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return;
        }

        const { document } = editor;
        const fileName = path.basename(document.fileName);
        const content = document.getText();

        if (document.languageId !== "ansible" || !isPlaybook(content)) {
          return;
        }

        ExplanationPanel.render(context, "playbook", {
          content,
          fileName,
        });
      },
    ),
  );

  // Listen for text selection changes
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(async () => {
      rejectPendingSuggestion();
    }),
  );

  // At window focus change, check if an inline suggestion is pending and ignore it if it exists.
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(async (state: vscode.WindowState) => {
      if (!state.focused) {
        ignorePendingSuggestion();
      }
    }),
  );

  // register ansible meta data in the statusbar tooltip (client-server)
  context.subscriptions.push(
    window.onDidChangeActiveTextEditor(
      async (editor: vscode.TextEditor | undefined) => {
        await updateAnsibleStatusBar(
          metaData,
          lightSpeedManager,
          pythonInterpreterManager,
        );
        await updateDocumentInRoleContext();
        if (!editor) {
          await ignorePendingSuggestion();
        }
        if (!extSettings.settings.lightSpeedService.enabled) {
          return;
        }
        lightSpeedManager.lightspeedExplorerProvider.refreshWebView();
      },
    ),
  );
  context.subscriptions.push(
    workspace.onDidOpenTextDocument(async () => {
      await updateAnsibleStatusBar(
        metaData,
        lightSpeedManager,
        pythonInterpreterManager,
      );
      if (!extSettings.settings.lightSpeedService.enabled) {
        return;
      }
      metaData.sendAnsibleMetadataTelemetry();
    }),
  );
  context.subscriptions.push(
    workspace.onDidChangeTextDocument(
      (event: vscode.TextDocumentChangeEvent) => {
        if (
          event.document === vscode.window.activeTextEditor?.document &&
          event.contentChanges.length > 0 &&
          event.contentChanges[0].text[0] !== "\n"
        ) {
          setDocumentChanged(true);
        }
      },
    ),
  );
  context.subscriptions.push(
    workspace.onDidChangeTextDocument(
      (event: vscode.TextDocumentChangeEvent) => {
        if (
          event.document === vscode.window.activeTextEditor?.document &&
          event.contentChanges.length > 0 &&
          event.contentChanges[0].text[0] !== "\n"
        ) {
          setDocumentChanged(true);
        }
      },
    ),
  );

  context.subscriptions.push(
    workspace.onDidChangeConfiguration(async () => {
      await updateConfigurationChanges(
        metaData,
        pythonInterpreterManager,
        extSettings,
        lightSpeedManager,
      );
      await updateAnsibleStatusBar(
        metaData,
        lightSpeedManager,
        pythonInterpreterManager,
      );
      metaData.sendAnsibleMetadataTelemetry();
    }),
  );

  context.subscriptions.push(
    workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) => {
      inlineSuggestionTextDocumentChangeHandler(e);
    }),
  );

  context.subscriptions.push(
    workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) => {
      inlineSuggestionTextDocumentChangeHandler(e);
    }),
  );

  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions(async (e) => {
      if (!LightspeedUser.isLightspeedUserAuthProviderType(e.provider.id)) {
        return;
      }
      await lightSpeedManager.lightspeedAuthenticatedUser.refreshLightspeedUser();
      if (!lightSpeedManager.lightspeedAuthenticatedUser.isAuthenticated()) {
        lightSpeedManager.currentModelValue = undefined;
      }
      if (!extSettings.settings.lightSpeedService.enabled) {
        return;
      }
      if (lightSpeedManager.lightspeedExplorerProvider.webviewView) {
        lightSpeedManager.lightspeedExplorerProvider.refreshWebView();
      }
      lightSpeedManager.statusBarProvider.updateLightSpeedStatusbar();
    }),
  );

  const quickLinksHome = new QuickLinksWebviewViewProvider(
    context.extensionUri,
  );

  const quickLinksDisposable = window.registerWebviewViewProvider(
    QuickLinksWebviewViewProvider.viewType,
    quickLinksHome,
  );

  context.subscriptions.push(quickLinksDisposable);

  // handle lightSpeed feedback
  const lightspeedFeedbackProvider = new LightspeedFeedbackWebviewViewProvider(
    context.extensionUri,
  );

  // Register the Lightspeed provider for a Webview View
  const lightspeedFeedbackDisposable = window.registerWebviewViewProvider(
    LightspeedFeedbackWebviewViewProvider.viewType,
    lightspeedFeedbackProvider,
  );

  context.subscriptions.push(lightspeedFeedbackDisposable);

  // Register the Lightspeed provider for a Webview
  const lightspeedFeedbackCommand = vscode.commands.registerCommand(
    LightSpeedCommands.LIGHTSPEED_FEEDBACK,
    () => {
      LightspeedFeedbackWebviewProvider.render(context.extensionUri);
    },
  );

  context.subscriptions.push(lightspeedFeedbackCommand);

  // Register the Sign in with Red Hat command
  const lightspeedSignInWithRedHatCommand = vscode.commands.registerCommand(
    LightSpeedCommands.LIGHTSPEED_SIGN_IN_WITH_REDHAT,
    async () => {
      // NOTE: We can't gate this check on if this extension is active,
      // because it only activates on an authentication request.
      if (!vscode.extensions.getExtension("redhat.vscode-redhat-account")) {
        window.showErrorMessage(
          "You must install the Red Hat Authentication extension to sign in with Red Hat.",
        );
        return;
      }
      lightspeedLogin(AuthProviderType.rhsso);
    },
  );
  context.subscriptions.push(lightspeedSignInWithRedHatCommand);

  // Register the Sign in with Lightspeed command
  const lightspeedSignInWithLightspeedCommand = vscode.commands.registerCommand(
    LightSpeedCommands.LIGHTSPEED_SIGN_IN_WITH_LIGHTSPEED,
    () => {
      lightspeedLogin(AuthProviderType.lightspeed);
    },
  );
  context.subscriptions.push(lightspeedSignInWithLightspeedCommand);

  /**
   * Handle "Ansible Tox" in the extension
   */
  const ansibleToxController = new AnsibleToxController();
  context.subscriptions.push(await ansibleToxController.create());

  const workspaceTox = findProjectDir();

  if (workspaceTox) {
    const testProvider = new AnsibleToxProvider(workspaceTox);
    context.subscriptions.push(
      vscode.tasks.registerTaskProvider(
        AnsibleToxProvider.toxType,
        testProvider,
      ),
    );
  }

  /**
   * Handle "Ansible Creator" in the extension
   */

  // pip install ansible-creator
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.content-creator.install",
      async () => {
        const extSettings = new SettingsManager();
        await extSettings.initialize();

        const pythonInterpreter = extSettings.settings.interpreterPath;

        // specify the current python interpreter path in the pip installation
        const { command, env } = withInterpreter(
          extSettings.settings,
          `${pythonInterpreter} -m pip install ansible-creator`,
          "--no-input",
        );

        let terminal;
        if (
          vscode.workspace.getConfiguration("ansible.ansible").reuseTerminal
        ) {
          terminal = vscode.window.terminals.find(
            (terminal) => terminal.name === "Ansible Terminal",
          ) as vscode.Terminal;
        }
        terminal = vscode.window.createTerminal({
          name: "Ansible Terminal",
          env: env,
        });
        terminal.show();
        terminal.sendText(command);
      },
    ),
  );

  // open ansible extension workspace settings directly
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.extension-settings.open",
      async () => {
        await vscode.commands.executeCommand(
          "workbench.action.openWorkspaceSettings",
          "ansible",
        );
      },
    ),
  );

  // open ansible-python workspace settings directly
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.python-settings.open",
      async () => {
        await vscode.commands.executeCommand(
          "workbench.action.openWorkspaceSettings",
          "ansible.python",
        );
      },
    ),
  );

  // open ansible-content-creator menu
  context.subscriptions.push(
    vscode.commands.registerCommand("ansible.content-creator.menu", () => {
      AnsibleWelcomePage.render(context.extensionUri);
    }),
  );

  // open web-view for creating ansible collection
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.content-creator.create-ansible-collection",
      () => {
        createAnsibleCollectionPanel.render(context);
      },
    ),
  );

  // open web-view for creating ansible playbook project
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.content-creator.create-ansible-project",
      () => {
        createAnsibleProjectPanel.render(context);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.content-creator.add-pattern",
      () => {
        addPatternPanel.render(context);
      },
    ),
  );

  // open web-view for creating devfile
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.content-creator.create-devfile",
      () => {
        CreateDevfile.render(context.extensionUri);
      },
    ),
  );

  // open web-view for creating Execution Environment file
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.content-creator.create-execution-env-file",
      () => {
        CreateExecutionEnv.render(context.extensionUri);
      },
    ),
  );

  // open web-view for creating devcontainer
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.content-creator.create-devcontainer",
      () => {
        CreateDevcontainer.render(context.extensionUri);
      },
    ),
  );

  // open web-view for adding a plugin in an ansible collection
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.content-creator.add-plugin",
      () => {
        addPluginPanel.render(context);
      },
    ),
  );

  // open web-view for adding role in an ansible collection
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.content-creator.create-role",
      () => {
        createRolePanel.render(context);
      },
    ),
  );

  // open ansible-creator create
  context.subscriptions.push(
    vscode.commands.registerCommand("ansible.content-creator.create", () => {
      window.showInformationMessage("This feature is coming soon. Stay tuned.");
    }),
  );

  // open ansible-creator sample
  context.subscriptions.push(
    vscode.commands.registerCommand("ansible.content-creator.sample", () => {
      window.showInformationMessage("This feature is coming soon. Stay tuned.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      LightSpeedCommands.LIGHTSPEED_PLAYBOOK_GENERATION,
      async () => {
        PlaybookGenerationPanel.render(context);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      LightSpeedCommands.LIGHTSPEED_ROLE_GENERATION,
      async () => {
        RoleGenerationPanel.render(context);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ansible.hello.world", async () => {
      HelloWorldPanel.render(context);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      LightSpeedCommands.LIGHTSPEED_ROLE_EXPLANATION,
      async () => {
        if (!vscode.window.activeTextEditor) {
          return;
        }
        const document = vscode.window.activeTextEditor.document;
        const documentInRole = await isDocumentInRole(document);

        if (!documentInRole) {
          return;
        }

        const roleName = getRoleNameFromFilePath(document.fileName);
        const rolePath = getRoleNamePathFromFilePath(document.fileName);

        const files = await getRoleYamlFiles(rolePath);

        ExplanationPanel.render(context, "role", {
          roleName: roleName,
          files: files,
        });
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.lightspeed.thumbsUpDown",
      async (param: PlaybookFeedbackEvent) => {
        if (param.explanationId) {
          lightSpeedManager.apiInstance.feedbackRequest(
            { playbookExplanationFeedback: param },
            true,
            true,
          );
        } else {
          lightSpeedManager.apiInstance.feedbackRequest(
            { playbookOutlineFeedback: param },
            true,
            true,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.lightspeed.roleThumbsUpDown",
      async (param: RoleFeedbackEvent) => {
        lightSpeedManager.apiInstance.feedbackRequest(
          { roleExplanationFeedback: param },
          true,
          true,
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.lightspeed.enableExperimentalFeatures",
      () => {
        vscode.commands.executeCommand(
          "setContext",
          "redhat.ansible.lightspeedExperimentalEnabled",
          true,
        );
        lightSpeedManager.lightspeedExplorerProvider.lightspeedExperimentalEnabled = true;
        if (!extSettings.settings.lightSpeedService.enabled) {
          return;
        }
        lightSpeedManager.lightspeedExplorerProvider.refreshWebView();
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      LightSpeedCommands.LIGHTSPEED_OPEN_TRIAL_PAGE,
      () => {
        vscode.env.openExternal(
          vscode.Uri.parse(
            lightSpeedManager.settingsManager.settings.lightSpeedService.URL +
              "/trial",
          ),
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      LightSpeedCommands.LIGHTSPEED_REFRESH_EXPLORER_VIEW,
      async () => {
        await lightSpeedManager.lightspeedAuthenticatedUser.updateUserInformation();
        lightSpeedManager.lightspeedExplorerProvider.refreshWebView();
      },
    ),
  );

  // getting started walkthrough command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.walkthrough.gettingStarted.setLanguage",
      () => {
        vscode.commands.executeCommand("runCommands", {
          commands: [
            "workbench.action.focusRightGroup",
            "workbench.action.editor.changeLanguageMode",
          ],
        });
      },
    ),
  );

  // install ansible development tools
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.install-ansible-dev-tools",
      async () => {
        const extSettings = new SettingsManager();
        await extSettings.initialize();

        const pythonInterpreter = extSettings.settings.interpreterPath;

        // specify the current python interpreter path in the pip installation
        const { command, env } = withInterpreter(
          extSettings.settings,
          `${pythonInterpreter} -m pip install ansible-dev-tools`,
          "--no-input",
        );

        const outputChannel = window.createOutputChannel(`Ansible Logs`);

        let commandOutput = "";
        let commandPassed = false;

        vscode.window.withProgress(
          {
            title: "Please wait...",
            location: vscode.ProgressLocation.Notification,
            cancellable: true,
          },
          async (_, token) => {
            // You code to process the progress

            token.onCancellationRequested(async () => {
              await vscode.window.showErrorMessage("Installation cancelled");
            });

            try {
              const result = execSync(command, {
                env: env,
              }).toString();
              commandOutput = result;
              outputChannel.append(commandOutput);
              commandPassed = true;
            } catch (error) {
              let errorMessage: string;
              if (error instanceof Error) {
                const execError = error as ExecException & {
                  // according to the docs, these are always available
                  stdout: string;
                  stderr: string;
                };

                errorMessage = execError.stdout
                  ? execError.stdout
                  : execError.stderr;
                errorMessage += execError.message;
              } else {
                errorMessage = `Exception: ${JSON.stringify(error)}`;
              }

              commandOutput = errorMessage;
              outputChannel.append(commandOutput);
              commandPassed = false;
            }
          },
        );

        if (commandPassed) {
          const selection = await vscode.window.showInformationMessage(
            "Ansible Development Tools installed successfully.",
            "Show Logs",
          );

          if (selection !== undefined) {
            outputChannel.show();
          }
        } else {
          const selection = await vscode.window.showErrorMessage(
            "Ansible Development Tools failed to install.",
            "Show Logs",
          );

          if (selection !== undefined) {
            outputChannel.show();
          }
        }
      },
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.open-walkthrough-create-env",
      () => {
        vscode.commands.executeCommand(
          "workbench.action.openWalkthrough",
          "redhat.ansible#create-ansible-environment",
          false,
        );
      },
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ansible.create-playbook-options",
      async () => {
        const isAuthenticated =
          await lightSpeedManager.lightspeedAuthenticatedUser.isAuthenticated();
        if (isAuthenticated) {
          vscode.commands.executeCommand(
            "ansible.lightspeed.playbookGeneration",
          );
        } else {
          vscode.commands.executeCommand("ansible.create-empty-playbook");
        }
      },
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("ansible.create-empty-playbook", () => {
      const playbookTemplate = `---\n# Write your playbook below.\n# Replace these contents with the tasks you'd like to complete and the modules you need.\n# For help getting started, check out https://www.redhat.com/en/topics/automation/what-is-an-ansible-playbook\n`;

      vscode.workspace
        .openTextDocument({
          content: playbookTemplate,
          language: "ansible",
        })
        .then((newDocument) => {
          vscode.window.showTextDocument(newDocument);
        });
    }),
  );
  // open ansible language server logs
  context.subscriptions.push(
    vscode.commands.registerCommand("ansible.open-language-server-logs", () => {
      lsOutputChannel.show();
    }),
  );
  context.subscriptions.push(eeBuilderCommand);
}

const startClient = async (
  context: ExtensionContext,
  telemetry: TelemetryManager,
) => {
  const serverModule = context.asAbsolutePath(
    path.join("out", "server", "src", "server.js"),
  );

  // server is run at port 6009 for debugging
  const debugOptions = { execArgv: ["--nolazy", "--inspect=6010"] };

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions,
    },
  };

  const telemetryErrorHandler = new TelemetryErrorHandler(
    telemetry.telemetryService,
    lsName,
    4,
  );
  const outputChannel = window.createOutputChannel(lsName);
  lsOutputChannel = outputChannel;

  const clientOptions: LanguageClientOptions = {
    // register the server for Ansible documents
    documentSelector: [{ scheme: "file", language: "ansible" }],
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    errorHandler: telemetryErrorHandler,
    outputChannel: new TelemetryOutputChannel(
      outputChannel,
      telemetry.telemetryService,
    ),
  };

  client = new LanguageClient(
    "ansibleServer",
    "Ansible Server",
    serverOptions,
    clientOptions,
  );

  // TODO: Temporary pause this telemetry event, will be enabled in future
  // context.subscriptions.push(
  //   client.onTelemetry((e) => {
  //     telemetry.telemetryService.send(e);
  //   }),
  // );

  try {
    await client.start();

    // If the extensions change, fire this notification again to pick up on any association changes
    extensions.onDidChange(() => {
      notifyAboutConflicts();
    });
    // TODO: Temporary pause this telemetry event, will be enabled in future
    // telemetry.sendStartupTelemetryEvent(true);
  } catch (err) {
    let errorMessage: string;
    if (err instanceof Error) {
      errorMessage = err.message;
    } else {
      errorMessage = String(err);
    }
    console.error(`Language Client initialization failed with ${errorMessage}`);
    // TODO: Temporary pause this telemetry event, will be enabled in future
    // telemetry.sendStartupTelemetryEvent(false, errorMessage);
  }
};

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}

async function updateAnsibleStatusBar(
  metaData: MetadataManager,
  lightSpeedManager: LightSpeedManager,
  pythonInterpreterManager: PythonInterpreterManager,
) {
  await metaData.updateAnsibleInfoInStatusbar();
  await lightSpeedManager.statusBarProvider.updateLightSpeedStatusbar();
  await pythonInterpreterManager.updatePythonInfoInStatusbar();
}
/**
 * Finds extensions that conflict with our extension.
 * If one or more conflicts are found then show an uninstall notification
 * If no conflicts are found then do nothing
 */
function notifyAboutConflicts(): void {
  const conflictingExtensions = getConflictingExtensions();
  if (conflictingExtensions.length > 0) {
    showUninstallConflictsNotification(conflictingExtensions);
  }
}

/**
 * Sends notification to the server to invalidate ansible inventory service cache
 * And resync the ansible inventory
 */

async function resyncAnsibleInventory(): Promise<void> {
  if (client.isRunning()) {
    client.onNotification(
      new NotificationType(`resync/ansible-inventory`),
      (event) => {
        console.log("resync ansible inventory event ->", event);
      },
    );
    client.sendNotification(new NotificationType(`resync/ansible-inventory`));
  }
}

async function lightspeedLogin(
  providerType: AuthProviderType | undefined,
): Promise<void> {
  lightSpeedManager.currentModelValue = undefined;
  const authenticatedUser =
    await lightSpeedManager.lightspeedAuthenticatedUser.getLightspeedUserDetails(
      true,
      providerType,
    );
  if (authenticatedUser) {
    window.showInformationMessage(
      `Welcome back ${authenticatedUser.displayNameWithUserType}`,
    );
  }
}

async function updateDocumentInRoleContext() {
  const document = vscode.window.activeTextEditor?.document;
  const isInRole = document
    ? await isDocumentInRole(document).catch(() => false)
    : false;
  vscode.commands.executeCommand(
    "setContext",
    "redhat.ansible.isDocumentInRole",
    isInRole,
  );
}
