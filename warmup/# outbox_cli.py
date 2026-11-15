# outbox_cli.py
import json
import random
rng=random.Random(42)

def load_messages():
    with open("Outbox.JSON","r") as file:
        return json.load(file)

def save_messages(messages):
    with open("Outbox.JSON","w") as file:
        json.dump(messages,file,indent=4)

def add_messages():
    messages=load_messages

    channel=input("Enter channel (email/sms): ").lower()
    recipient=input("Enter recipient: ")
    body=input("Enter message: ")

    if messages:
        message_id=max(message["id"] for message in messages) + 1
    else:
        message_id=1

    message=[
        {
            "id": message_id,
            "channel": channel,
            "recipient": recipient,
            "body": body,
            "status": "pending",
            "attempts": 0
        }
    ]

    messages.append(message)

    save_messages()
    print(f" Message accepted with ID: {message_id}")

def process_messages():
    messages=load_messages

    for message in messages:
        if message["status"]=="pending":
            message["attempt"]+=1
            if rng.random()<0.8:
                message["status"]="sent"
                print(f"Message {message["id"]} sent successfully.")
            else:
                message["status"]="failed"
                print(f"Message {message["id"]} failed")

    save_messages()

def view_messages():
    messages=load_messages

    for message in messages:
        print(message)

def main():
    while True:
        print("\n--DakGhar CLI--")
        print("1. Add message")
        print("2. Process pending messages")
        print("3. View messages")
        print("4. Exit")

        choice=int(input("Enter your choice: "))

        if choice==1:
            add_messages()
        elif choice==2:
            process_messages()
        elif choice==3:
            view_messages()
        elif choice==4:
            break
        else:
            print("Invalid Choice")

if __name__ == "__main__":
    main()