/* eslint-disable @typescript-eslint/no-namespace */

import { IAnsibleFileTypes } from "../interfaces/lightspeed";

export namespace AnsibleCommands {
  export const ANSIBLE_VAULT = "extension.ansible.vault";
  export const ANSIBLE_INVENTORY_RESYNC = "extension.resync-ansible-inventory";
  export const ANSIBLE_PLAYBOOK_RUN = "extension.ansible-playbook.run";
  export const ANSIBLE_NAVIGATOR_RUN = "extension.ansible-navigator.run";
  export const ANSIBLE_PYTHON_SET_INTERPRETER =
    "ansible.python.set.interpreter";
}

export const AnsibleFileTypes: IAnsibleFileTypes = {
  "**/playbooks/*.{yml,yaml}": "playbook",
  "**/*playbook*.{yml,yaml}": "playbook",
  "**/roles/**/tasks/**/*.{yml,yaml}": "tasks_in_role",
  "**/tasks/**/*.{yaml,yml}": "tasks",
};

export const PlaybookKeywords = [
  "hosts",
  "tasks",
  "vars_files",
  "roles",
  "pre_tasks",
  "post_tasks",
];

export const StandardRolePaths = [
  "~/.ansible/roles",
  "/usr/share/ansible/roles",
  "/etc/ansible/roles",
];

export const IncludeVarValidTaskName = [
  "include_vars",
  "ansible.builtin.include_vars",
  "ansible.legacy.include_vars",
];

export const ADE_ISOLATION_MODE_MIN = "25.4.0";

/* Slightly lower than CloudFront's timeout which is 30s. */
export const ANSIBLE_LIGHTSPEED_API_TIMEOUT = 28000;

export const ANSIBLE_CREATOR_VERSION_MIN = "24.10.1";

export const ANSIBLE_CREATOR_COLLECTION_VERSION_MIN = "24.7.1";

export const ANSIBLE_CREATOR_EE_VERSION_MIN = "24.12.1";

export const DevfileImages = {
  Upstream: "ghcr.io/ansible/ansible-devspaces:latest",
};

export const DevcontainerImages = {
  Upstream: "ghcr.io/ansible/community-ansible-dev-tools:latest",
  Downstream:
    "registry.redhat.io/ansible-automation-platform-25/ansible-dev-tools-rhel8:latest",
};

export const DevcontainerRecommendedExtensions = {
  RECOMMENDED_EXTENSIONS: ["redhat.ansible", "redhat.vscode-redhat-account"],
};
