import Clients from "@/models/client";
import { useState } from "react";
import { Modal, Paper } from "@mui/material";
import Form, { FormErrors, FormField, FormSubmit } from "../Form";
import ModelTable from "../ModelTable";
import { createUser } from "@/logic/admin";
import Admins from "@/models/admin";
import { useRouter } from "next/router";
import SearchTestView from "./test_search";
export default function UsersPage() {
  const [formCreationRequest, setFormCreationRequest] = useState(null);
  const [userModel, setUserModel] = useState(Admins);
  const _return = (value) => {
    setFormCreationRequest((e) => {
      e?.(value);
      return null;
    });
  };
  const router = useRouter();
  return (
    <>
      <Modal
        open={!!formCreationRequest}
        onClose={() => _return(false)}
        className="flex justify-center items-center"
      >
        <Paper className="max-w-xl pt-4 px-8 max-sm:px-4 pb-4">
          <Form
            initialValue={{ email: "" }}
            onSubmit={async ({ email }) => {
              const DEFAULT_PASSWORD = "student987";
              let s = await createUser(email, DEFAULT_PASSWORD);
              let m = await userModel.getOrCreate(s, async (item, txn) => {
                if (item.isLocalOnly()) await item.set({ email: email }, txn);
              });
              _return(m);
            }}
          >
            <FormErrors />
            <FormField name="email" label="Email address" type="email" />
            <FormSubmit
              variant="contained"
              sx={{ mt: 5, mx: "auto", display: "block" }}
            >
              Done
            </FormSubmit>
          </Form>
        </Paper>
      </Modal>
      <SearchTestView />
      <ModelTable
        Model={Clients}
        allowDelete={false}
        onClickRow={(user) =>
          router.replace(
            "?tab=prescriptions&user=" + encodeURIComponent(user.id())
          )
        }
        onCreate={() => {
          return new Promise((r, j) => {
            setUserModel(Clients);
            setFormCreationRequest(() => r);
          });
        }}
      />
      <ModelTable
        Model={Admins}
        allowDelete={false}
        onCreate={() => {
          return new Promise((r, j) => {
            setUserModel(Admins);
            setFormCreationRequest(() => r);
          });
        }}
      />
    </>
  );
}
