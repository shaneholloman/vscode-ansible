// BEFORE: ansible.lightspeed.enabled: true
import {
  ActionsControl,
  ActivityBar,
  By,
  ContextMenu,
  EditorView,
  InputBox,
  ModalDialog,
  SideBarView,
  ViewControl,
  ViewSection,
  VSBrowser,
  until,
  WebviewView,
  Workbench,
} from "vscode-extension-tester";
import {
  expectNotification,
  getFixturePath,
  getModalDialogAndMessage,
  getWebviewByLocator,
  sleep,
  waitForCondition,
  workbenchExecuteCommand,
} from "./uiTestHelper";
import { Key } from "selenium-webdriver";
import { expect } from "chai";

const trialNotificationMessage =
  "Ansible Lightspeed is not configured for your organization, click here to start a 90-day trial.";

before(function () {
  if (process.platform !== "darwin") {
    this.skip();
  }
});

describe("Test One Click Trial feature", () => {
  let workbench: Workbench;
  let explorerView: WebviewView;
  let modalDialog: ModalDialog;
  let dialogMessage: string;
  let sideBar: SideBarView;
  let view: ViewControl;
  let adtView: ViewSection;
  let alfView: ViewSection;

  beforeEach(function () {
    if (!process.env.TEST_LIGHTSPEED_URL) {
      this.skip();
    }
  });

  before(async () => {
    if (!process.env.TEST_LIGHTSPEED_URL) {
      return;
    }

    // Enable Lightspeed and open Ansible Light view on sidebar
    workbench = new Workbench();
    // Close settings and other open editors (if any)
    await workbenchExecuteCommand("View: Close All Editor Groups");

    // Set "UI Test" and "One Click" options for mock server
    try {
      await fetch(`${process.env.TEST_LIGHTSPEED_URL}/__debug__/options`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["--ui-test", "--one-click"]),
      });
    } catch (error) {
      console.error(
        "Failed to set ui-test and one-click options for lightspeed mock server",
        error,
      );
      expect.fail(
        "Failed to set ui-test and one-click options for lightspeed mock server",
      );
    }
  });

  it("Focus on Ansible Lightspeed View", async () => {
    view = (await new ActivityBar().getViewControl("Ansible")) as ViewControl;
    sideBar = await view.openView();

    adtView = await sideBar
      .getContent()
      .getSection("Ansible Development Tools");
    await adtView.collapse();

    alfView = await sideBar
      .getContent()
      .getSection("Ansible Lightspeed Feedback");
    await alfView.collapse();

    explorerView = new WebviewView(new SideBarView());
    expect(explorerView, "contentCreatorWebView should not be undefined").not.to
      .be.undefined;
  });

  it("Click Connect button Ansible Lightspeed webview", async () => {
    await explorerView.switchToFrame(5000);

    const connectButton = await explorerView.findWebElement(
      By.id("lightspeed-explorer-connect"),
    );
    expect(connectButton).not.to.be.undefined;
    if (connectButton) {
      await connectButton.click();
    }
    await explorerView.switchBack();
  });

  it("Click Allow to use Lightspeed", async () => {
    // Click Allow to use Lightspeed
    const { dialog, message } = await getModalDialogAndMessage(true);
    expect(message).equals(
      "The extension 'Ansible' wants to sign in using Ansible Lightspeed.",
    );
    await dialog.pushButton("Allow");
  });

  it("Verify a modal dialog pops up", async () => {
    const { dialog, message } = await getModalDialogAndMessage();
    expect(dialog).not.to.be.undefined;
    expect(message).not.to.be.undefined;
    modalDialog = dialog;
    dialogMessage = message;
  });

  it("Click Open if a dialog shows up for opening the external website", async () => {
    // If the dialog to open the external website is not suppressed, click Open
    if (dialogMessage === "Do you want Code to open the external website?") {
      await modalDialog.pushButton("Configure Trusted Domains");
      const input = await InputBox.create();
      input.confirm();

      const d = await getModalDialogAndMessage();
      modalDialog = d.dialog;
      dialogMessage = d.message;
    }
  });

  it("Click Open to open the callback URI", async () => {
    // Click Open to allow Ansible extension to open the callback URI
    expect(dialogMessage).equals("Allow 'Ansible' extension to open this URI?");
    await modalDialog.pushButton("Open");
    await sleep(2000);
  });

  it("Verify Ansible Lightspeed webview now contains user's information", async () => {
    await explorerView.switchToFrame(5000);

    const div = await waitForCondition({
      condition: async () => {
        return await explorerView.findWebElement(
          By.id("lightspeedExplorerView"),
        );
      },
      message: "Timed out waiting for lightspeedExplorerView element",
    });

    const text = await div.getText();
    expect(text).contains("Logged in as: ONE_CLICK_USER (unlicensed)");
    await explorerView.switchBack();
    await expectNotification("Welcome back ONE_CLICK_USER (unlicensed)");
  });

  it("Verify the Refresh icon is found on the title of Explorer view", async () => {
    const refreshIcon = await explorerView.findWebElement(
      By.xpath("//a[contains(@class, 'codicon-refresh')]"),
    );
    expect(refreshIcon, "refreshIcon should not be undefined").not.to.be
      .undefined;

    // Set "UI Test", "One Click" and "Me Uppercase" options for mock server
    try {
      await fetch(`${process.env.TEST_LIGHTSPEED_URL}/__debug__/options`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["--ui-test", "--one-click", "--me-uppercase"]),
      });
    } catch (error) {
      console.error(
        "Failed to set ui-test, one-click and me-uppercase options for lightspeed mock server",
        error,
      );
      expect.fail(
        "Failed to set ui-test, one-click and me-uppercase options for lightspeed mock server",
      );
    }

    await refreshIcon.click(); // make sure if it could be clicked

    await explorerView.switchToFrame(5000);
    const div = await explorerView.findWebElement(
      By.id("lightspeedExplorerView"),
    );
    const text = await div.getText();
    expect(text).contains("LOGGED IN AS: ONE_CLICK_USER (UNLICENSED)");
    await explorerView.switchBack();
  });

  it("Invoke Playbook generation", async () => {
    await workbench.executeCommand("Ansible Lightspeed: Playbook generation");
    await getWebviewByLocator(
      By.xpath("//*[text()='Create a playbook with Ansible Lightspeed']"),
    );
    await workbenchExecuteCommand("View: Close All Editor Groups");
  });

  it("Invoke Playbook explanation", async () => {
    const folder = "lightspeed";
    const file = "playbook_4.yml";
    const filePath = getFixturePath(folder, file);

    // Open file in the editor
    await VSBrowser.instance.openResources(filePath);

    // Open playbook explanation webview.
    await workbench.executeCommand(
      "Explain the playbook with Ansible Lightspeed",
    );
    await expectNotification(
      trialNotificationMessage,
      true, // click button
    );
    await workbenchExecuteCommand("View: Close All Editor Groups");
  });

  it("Invoke Completion", async () => {
    const folder = "lightspeed";
    const file = "playbook_3.yml";
    const filePath = getFixturePath(folder, file);
    await VSBrowser.instance.openResources(filePath);

    const editorView = new EditorView();
    const tab = await editorView.getTabByTitle(file);
    await tab.select();

    // Trigger completions API. First space key and backspace look redundant,
    // but just sending page down and 4 spaces did not work...
    await tab.sendKeys(" ", Key.BACK_SPACE, Key.PAGE_DOWN, "    ");
    await expectNotification(
      trialNotificationMessage,
      true, // click button
    );

    // Revert changes made
    await tab.select();
    await tab.sendKeys(Key.CONTROL, "z", "z", "z", Key.NULL);
    await workbenchExecuteCommand("View: Close All Editor Groups");

    // The undo's don't seem to (always) work.. So discard changes
    const dialog = new ModalDialog();
    await dialog.pushButton(`Don't Save`);
    await dialog.getDriver().wait(until.stalenessOf(dialog), 2000);
  });

  it("Sign out using Accounts global action", async () => {
    workbench = new Workbench();
    const activityBar = new ActivityBar();
    const actions = (await activityBar.getGlobalAction(
      "Accounts",
    )) as ActionsControl;
    expect(actions).not.to.be.undefined;
    await actions.click();
    const menus = await workbench.findElements(By.className("context-view"));
    expect(menus.length).greaterThan(0);
    const menu = new ContextMenu(workbench);
    expect(menu).not.to.be.undefined;
    if (menu) {
      await menu.select(
        "ONE_CLICK_USER (unlicensed) (Ansible Lightspeed)",
        "Sign Out",
      );
    }
  });
});
